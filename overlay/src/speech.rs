use crate::pronunciation::Pronouncer;
use std::{
    env, fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc::{self, Sender},
    thread,
    time::Duration,
};

#[derive(Clone, Debug)]
enum Backend {
    Piper {
        program: PathBuf,
        model: PathBuf,
        config: PathBuf,
        player: PathBuf,
        audio: PathBuf,
    },
    Disabled(String),
    Unavailable(String),
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
        let worker_backend = backend.clone();
        thread::spawn(move || {
            let mut running: Option<Child> = None;
            let mut pending_audio = audio_path(&worker_backend);
            let mut queued = None;
            loop {
                let mut text = match queued.take() {
                    Some(text) => text,
                    None => match receiver.recv() {
                        Ok(text) => text,
                        Err(_) => return,
                    },
                };
                for newer in receiver.try_iter() {
                    text = newer;
                }
                cancel(&mut running, pending_audio.as_deref());
                let (child, audio) = match start_piper(&worker_backend, &text) {
                    Ok(started) => started,
                    Err(error) => {
                        eprintln!("codex-agent-overlay: neural speech unavailable: {error}");
                        continue;
                    }
                };
                running = Some(child);
                pending_audio = Some(audio);

                loop {
                    match receiver.recv_timeout(Duration::from_millis(50)) {
                        Ok(mut newer) => {
                            for latest in receiver.try_iter() {
                                newer = latest;
                            }
                            cancel(&mut running, pending_audio.as_deref());
                            match start_piper(&worker_backend, &newer) {
                                Ok((child, audio)) => {
                                    running = Some(child);
                                    pending_audio = Some(audio);
                                }
                                Err(error) => {
                                    eprintln!(
                                        "codex-agent-overlay: neural speech unavailable: {error}"
                                    );
                                    break;
                                }
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            let Some(status) = running
                                .as_mut()
                                .and_then(|process| process.try_wait().ok().flatten())
                            else {
                                continue;
                            };
                            running = None;
                            if !status.success() {
                                eprintln!(
                                    "codex-agent-overlay: Piper exited with {status}; speech remains silent"
                                );
                                cleanup(pending_audio.as_deref());
                                break;
                            }
                            let Some(audio) = pending_audio.as_ref() else {
                                break;
                            };
                            match start_player(&worker_backend, audio) {
                                Ok(child) => running = Some(child),
                                Err(error) => {
                                    eprintln!(
                                        "codex-agent-overlay: audio playback failed: {error}"
                                    );
                                    cleanup(pending_audio.as_deref());
                                    break;
                                }
                            }
                            queued = wait_for_playback(&receiver, &mut running, &mut pending_audio);
                            break;
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            cancel(&mut running, pending_audio.as_deref());
                            return;
                        }
                    }
                }
            }
        });
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

fn backend_from_environment() -> Backend {
    let selected = env::var("CODEX_OVERLAY_TTS_BACKEND").unwrap_or_else(|_| "piper".to_owned());
    if matches!(validate_backend_name(&selected), Ok(false)) {
        return Backend::Disabled("speech is disabled".into());
    }
    if let Err(error) = validate_backend_name(&selected) {
        return Backend::Unavailable(error);
    }

    let data = data_home();
    let program = env::var_os("CODEX_OVERLAY_PIPER_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|| data.join("codex-webui/piper/piper"));
    let model = env::var_os("CODEX_OVERLAY_PIPER_MODEL")
        .map(PathBuf::from)
        .unwrap_or_else(|| data.join("codex-webui/piper/pl_PL-darkman-medium.onnx"));
    let config = env::var_os("CODEX_OVERLAY_PIPER_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|| data.join("codex-webui/piper/pl_PL-darkman-medium.onnx.json"));
    let player = env::var_os("CODEX_OVERLAY_AUDIO_PLAYER")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/usr/bin/pw-play"));
    let audio = runtime_home().join("codex-agent-overlay-speech.wav");
    Backend::Piper {
        program,
        model,
        config,
        player,
        audio,
    }
}

fn validate_backend_name(selected: &str) -> Result<bool, String> {
    match selected {
        "piper" => Ok(true),
        "disabled" | "none" => Ok(false),
        _ => Err(format!(
            "unsupported backend {selected:?}; only piper or disabled are accepted"
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
        Backend::Piper {
            program,
            model,
            config,
            player,
            ..
        } => validate_file(program, true)
            .and_then(|_| validate_file(model, false))
            .and_then(|_| validate_file(config, false))
            .and_then(|_| validate_file(player, true))
            .err(),
    }
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
        Backend::Piper { audio, .. } => Some(audio.clone()),
        _ => None,
    }
}

fn start_piper(backend: &Backend, text: &str) -> std::io::Result<(Child, PathBuf)> {
    let Backend::Piper {
        program,
        model,
        config,
        audio,
        ..
    } = backend
    else {
        return Err(std::io::Error::other("neural speech is unavailable"));
    };
    cleanup(Some(audio));
    let mut child = Command::new(program)
        .args(["--model", path_str(model)?, "--config", path_str(config)?])
        .args(["--output_file", path_str(audio)?, "--quiet"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()?;
    if let Some(mut stdin) = child.stdin.take()
        && let Err(error) = stdin
            .write_all(text.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
    {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    Ok((child, audio.clone()))
}

fn start_player(backend: &Backend, audio: &Path) -> std::io::Result<Child> {
    let Backend::Piper { player, .. } = backend else {
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

fn wait_for_playback(
    receiver: &mpsc::Receiver<String>,
    running: &mut Option<Child>,
    audio: &mut Option<PathBuf>,
) -> Option<String> {
    while running.is_some() {
        match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(mut newer) => {
                for latest in receiver.try_iter() {
                    newer = latest;
                }
                cancel(running, audio.as_deref());
                return Some(newer);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if running
                    .as_mut()
                    .is_some_and(|process| process.try_wait().ok().flatten().is_some())
                {
                    *running = None;
                    cleanup(audio.as_deref());
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                cancel(running, audio.as_deref());
                return None;
            }
        }
    }
    None
}

fn cancel(child: &mut Option<Child>, audio: Option<&Path>) {
    if let Some(mut process) = child.take() {
        let _ = process.kill();
        let _ = process.wait();
    }
    cleanup(audio);
}

fn cleanup(audio: Option<&Path>) {
    if let Some(path) = audio {
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

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
    fn legacy_formant_backends_are_not_available_as_fallbacks() {
        assert!(
            validate_backend_name("spd-say")
                .unwrap_err()
                .contains("only piper")
        );
        assert!(validate_backend_name("espeak-ng").is_err());
    }
}
