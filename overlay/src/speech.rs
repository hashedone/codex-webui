use crate::pronunciation::Pronouncer;
use serde_json::{Value, json};
use std::{
    env, fs,
    io::{BufRead, BufReader, Write},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver, Sender},
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Debug)]
enum Backend {
    Supertonic {
        python: PathBuf,
        worker: PathBuf,
        model: PathBuf,
        player: PathBuf,
        audio: PathBuf,
    },
    Disabled(String),
    Unavailable(String),
}

#[derive(Debug)]
enum WorkerEvent {
    Ready,
    Done,
    Error(String),
}

struct Synthesizer {
    child: Child,
    stdin: ChildStdin,
    events: Receiver<WorkerEvent>,
}

impl Drop for Synthesizer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub struct Speaker {
    sender: Sender<String>,
    unavailable: Option<String>,
    pronouncer: Pronouncer,
}

impl Speaker {
    pub fn from_environment() -> Self {
        let pronouncer = Pronouncer::from_environment();
        let backend = backend_from_environment();
        let unavailable = pronouncer
            .as_ref()
            .err()
            .cloned()
            .or_else(|| backend_error(&backend));
        Self::new(backend, pronouncer.unwrap_or_default(), unavailable)
    }

    fn new(backend: Backend, pronouncer: Pronouncer, unavailable: Option<String>) -> Self {
        let (sender, receiver) = mpsc::channel::<String>();
        thread::spawn(move || speech_worker(backend, receiver));
        Self {
            sender,
            unavailable,
            pronouncer,
        }
    }

    pub fn speak(&self, text: String) -> Result<(), String> {
        if let Some(error) = &self.unavailable {
            return Err(format!("neural-speech-unavailable: {error}"));
        }
        self.sender
            .send(self.pronouncer.prepare(&text))
            .map_err(|_| "speech worker is unavailable".to_owned())
    }
}

fn speech_worker(backend: Backend, receiver: Receiver<String>) {
    let mut synthesizer = None;
    let mut queued = None;
    let audio = audio_path(&backend);

    loop {
        let mut text = match queued.take() {
            Some(text) => text,
            None => match receiver.recv() {
                Ok(text) => text,
                Err(_) => return,
            },
        };
        drain_latest(&receiver, &mut text);
        cleanup(audio.as_deref());

        if synthesizer.is_none() {
            match start_supertonic(&backend) {
                Ok(process) => synthesizer = Some(process),
                Err(error) => {
                    eprintln!("codex-agent-overlay: Supertonic failed to start: {error}");
                    continue;
                }
            }
            let ready = wait_until_ready(
                synthesizer.as_mut().expect("synthesizer was just started"),
                &receiver,
                &mut text,
            );
            if let Err(error) = ready {
                eprintln!("codex-agent-overlay: Supertonic unavailable: {error}");
                synthesizer = None;
                continue;
            }
        }

        let request = send_request(
            synthesizer.as_mut().expect("ready synthesizer"),
            &text,
            audio
                .as_deref()
                .expect("Supertonic backend has an audio path"),
        );
        if let Err(error) = request {
            eprintln!("codex-agent-overlay: Supertonic request failed: {error}");
            synthesizer = None;
            continue;
        }

        loop {
            match receiver.recv_timeout(Duration::from_millis(50)) {
                Ok(mut newer) => {
                    drain_latest(&receiver, &mut newer);
                    // ONNX inference is synchronous. Killing the resident worker is the only
                    // reliable cancellation boundary; its replacement stays warm afterwards.
                    synthesizer = None;
                    cleanup(audio.as_deref());
                    queued = Some(newer);
                    break;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }

            let event = synthesizer
                .as_ref()
                .and_then(|process| process.events.try_recv().ok());
            match event {
                Some(WorkerEvent::Done) => {
                    let mut playback = match start_player(&backend, audio.as_deref().unwrap()) {
                        Ok(child) => Some(child),
                        Err(error) => {
                            eprintln!("codex-agent-overlay: audio playback failed: {error}");
                            cleanup(audio.as_deref());
                            break;
                        }
                    };
                    queued = wait_for_playback(&receiver, &mut playback, audio.as_deref());
                    break;
                }
                Some(WorkerEvent::Error(error)) => {
                    eprintln!("codex-agent-overlay: Supertonic synthesis failed: {error}");
                    synthesizer = None;
                    cleanup(audio.as_deref());
                    break;
                }
                Some(WorkerEvent::Ready) | None => {
                    if synthesizer
                        .as_mut()
                        .is_some_and(|process| process.child.try_wait().ok().flatten().is_some())
                    {
                        eprintln!(
                            "codex-agent-overlay: Supertonic worker exited; speech remains silent"
                        );
                        synthesizer = None;
                        cleanup(audio.as_deref());
                        break;
                    }
                }
            }
        }
    }
}

fn backend_from_environment() -> Backend {
    let selected =
        env::var("CODEX_OVERLAY_TTS_BACKEND").unwrap_or_else(|_| "supertonic".to_owned());
    if matches!(validate_backend_name(&selected), Ok(false)) {
        return Backend::Disabled("speech is disabled".into());
    }
    if let Err(error) = validate_backend_name(&selected) {
        return Backend::Unavailable(error);
    }

    let data = data_home().join("codex-webui/supertonic");
    let python = env::var_os("CODEX_OVERLAY_SUPERTONIC_PYTHON")
        .map(PathBuf::from)
        .unwrap_or_else(|| data.join("venv/bin/python"));
    let worker = env::var_os("CODEX_OVERLAY_SUPERTONIC_WORKER")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/supertonic-worker.py")
        });
    let model = env::var_os("CODEX_OVERLAY_SUPERTONIC_MODEL")
        .map(PathBuf::from)
        .unwrap_or_else(|| data.join("model"));
    let player = env::var_os("CODEX_OVERLAY_AUDIO_PLAYER")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/usr/bin/pw-play"));
    let audio = runtime_home().join("codex-agent-overlay-speech.wav");
    Backend::Supertonic {
        python,
        worker,
        model,
        player,
        audio,
    }
}

fn validate_backend_name(selected: &str) -> Result<bool, String> {
    match selected {
        "supertonic" => Ok(true),
        "disabled" | "none" => Ok(false),
        _ => Err(format!(
            "unsupported backend {selected:?}; only supertonic or disabled are accepted"
        )),
    }
}

fn data_home() -> PathBuf {
    env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
        .unwrap_or_else(|| PathBuf::from("/nonexistent"))
}

fn runtime_home() -> PathBuf {
    env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(env::temp_dir)
}

fn backend_error(backend: &Backend) -> Option<String> {
    match backend {
        Backend::Disabled(reason) | Backend::Unavailable(reason) => Some(reason.clone()),
        Backend::Supertonic {
            python,
            worker,
            model,
            player,
            ..
        } => validate_file(python, true)
            .and_then(|_| validate_file(worker, false))
            .and_then(|_| validate_model(model))
            .and_then(|_| validate_file(player, true))
            .err(),
    }
}

fn validate_model(model: &Path) -> Result<(), String> {
    for relative in [
        "onnx/duration_predictor.onnx",
        "onnx/text_encoder.onnx",
        "onnx/tts.json",
        "onnx/unicode_indexer.json",
        "onnx/vector_estimator.onnx",
        "onnx/vocoder.onnx",
        "voice_styles/F5.json",
    ] {
        validate_file(&model.join(relative), false)?;
    }
    Ok(())
}

fn validate_file(path: &Path, executable: bool) -> Result<(), String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("required file {} is unavailable: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("required path {} is not a file", path.display()));
    }
    if executable && metadata.permissions().mode() & 0o111 == 0 {
        return Err(format!(
            "required program {} is not executable",
            path.display()
        ));
    }
    Ok(())
}

fn audio_path(backend: &Backend) -> Option<PathBuf> {
    match backend {
        Backend::Supertonic { audio, .. } => Some(audio.clone()),
        _ => None,
    }
}

fn start_supertonic(backend: &Backend) -> std::io::Result<Synthesizer> {
    let Backend::Supertonic {
        python,
        worker,
        model,
        ..
    } = backend
    else {
        return Err(std::io::Error::other("neural speech is unavailable"));
    };
    let mut child = Command::new(python)
        .arg(worker)
        .args([
            "--model-dir",
            path_str(model)?,
            "--voice",
            "F5",
            "--lang",
            "pl",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| std::io::Error::other("Supertonic stdin is unavailable"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| std::io::Error::other("Supertonic stdout is unavailable"))?;
    let (sender, events) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let event = match line {
                Ok(line) => parse_worker_event(&line),
                Err(error) => WorkerEvent::Error(format!("worker protocol read failed: {error}")),
            };
            if sender.send(event).is_err() {
                break;
            }
        }
    });
    Ok(Synthesizer {
        child,
        stdin,
        events,
    })
}

fn parse_worker_event(line: &str) -> WorkerEvent {
    let parsed: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(error) => return WorkerEvent::Error(format!("invalid worker response: {error}")),
    };
    match parsed.get("event").and_then(Value::as_str) {
        Some("ready") => WorkerEvent::Ready,
        Some("done") => WorkerEvent::Done,
        Some("error" | "fatal") => WorkerEvent::Error(
            parsed
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown worker error")
                .to_owned(),
        ),
        other => WorkerEvent::Error(format!("unknown worker event: {other:?}")),
    }
}

fn wait_until_ready(
    synthesizer: &mut Synthesizer,
    receiver: &Receiver<String>,
    latest: &mut String,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        drain_latest(receiver, latest);
        match synthesizer.events.recv_timeout(Duration::from_millis(50)) {
            Ok(WorkerEvent::Ready) => return Ok(()),
            Ok(WorkerEvent::Error(error)) => return Err(error),
            Ok(WorkerEvent::Done) => return Err("worker completed before it was ready".into()),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("worker protocol disconnected during startup".into());
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if synthesizer.child.try_wait().ok().flatten().is_some() {
            return Err("worker exited during model load".into());
        }
    }
    Err("worker model load timed out after 60 seconds".into())
}

fn send_request(synthesizer: &mut Synthesizer, text: &str, audio: &Path) -> std::io::Result<()> {
    serde_json::to_writer(
        &mut synthesizer.stdin,
        &json!({"text": text, "output": audio}),
    )?;
    synthesizer.stdin.write_all(b"\n")?;
    synthesizer.stdin.flush()
}

fn start_player(backend: &Backend, audio: &Path) -> std::io::Result<Child> {
    let Backend::Supertonic { player, .. } = backend else {
        return Err(std::io::Error::other("neural speech is unavailable"));
    };
    Command::new(player)
        .arg(audio)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
}

fn path_str(path: &Path) -> std::io::Result<&str> {
    path.to_str()
        .ok_or_else(|| std::io::Error::other("speech path is not valid UTF-8"))
}

fn drain_latest(receiver: &Receiver<String>, latest: &mut String) {
    for newer in receiver.try_iter() {
        *latest = newer;
    }
}

fn wait_for_playback(
    receiver: &Receiver<String>,
    running: &mut Option<Child>,
    audio: Option<&Path>,
) -> Option<String> {
    while running.is_some() {
        match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(mut newer) => {
                drain_latest(receiver, &mut newer);
                cancel_playback(running, audio);
                return Some(newer);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if running
                    .as_mut()
                    .is_some_and(|process| process.try_wait().ok().flatten().is_some())
                {
                    *running = None;
                    cleanup(audio);
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                cancel_playback(running, audio);
                return None;
            }
        }
    }
    None
}

fn cancel_playback(child: &mut Option<Child>, audio: Option<&Path>) {
    if let Some(mut process) = child.take() {
        let _ = process.kill();
        let _ = process.wait();
    }
    cleanup(audio);
}

fn cleanup(audio: Option<&Path>) {
    if let Some(path) = audio {
        let _ = fs::remove_file(path);
        if let (Some(stem), Some(extension)) = (
            path.file_stem().and_then(|name| name.to_str()),
            path.extension().and_then(|name| name.to_str()),
        ) {
            let _ = fs::remove_file(path.with_file_name(format!(".{stem}.tmp.{extension}")));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_neural_backend_reports_error_and_stays_silent() {
        let speaker = Speaker::new(
            Backend::Unavailable("model missing".into()),
            Pronouncer::default(),
            Some("model missing".into()),
        );
        assert_eq!(
            speaker.speak("status".into()).unwrap_err(),
            "neural-speech-unavailable: model missing"
        );
    }

    #[test]
    fn queueing_speech_does_not_block_the_controller() {
        let speaker = Speaker::new(
            Backend::Disabled("test worker".into()),
            Pronouncer::default(),
            None,
        );
        let started = Instant::now();
        speaker.speak("status".into()).unwrap();
        assert!(started.elapsed() < Duration::from_millis(50));
    }

    #[test]
    fn only_supertonic_is_available_as_the_neural_backend() {
        assert_eq!(validate_backend_name("supertonic"), Ok(true));
        assert!(
            validate_backend_name("piper")
                .unwrap_err()
                .contains("only supertonic")
        );
        assert!(validate_backend_name("espeak-ng").is_err());
    }

    #[test]
    fn worker_protocol_surfaces_explicit_errors() {
        assert!(matches!(
            parse_worker_event(r#"{"event":"ready"}"#),
            WorkerEvent::Ready
        ));
        assert!(matches!(
            parse_worker_event(r#"{"event":"done"}"#),
            WorkerEvent::Done
        ));
        assert!(matches!(
            parse_worker_event(r#"{"event":"error","message":"bad model"}"#),
            WorkerEvent::Error(message) if message == "bad model"
        ));
    }
}
