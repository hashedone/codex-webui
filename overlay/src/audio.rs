use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    env,
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::PathBuf,
    process::Command,
    thread,
    time::Duration,
};

const FADE_STEPS: u64 = 5;
const FADE_STEP_DELAY: Duration = Duration::from_millis(40);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct SavedStream {
    index: u64,
    identity: String,
    volumes: Vec<u64>,
    #[serde(default)]
    corked: bool,
}

fn parse_sink_inputs(json: &str) -> Result<Vec<SavedStream>, String> {
    let inputs: Vec<Value> = serde_json::from_str(json).map_err(|error| error.to_string())?;
    inputs
        .into_iter()
        .map(|input| {
            let index = input
                .get("index")
                .and_then(Value::as_u64)
                .ok_or_else(|| "sink input has no numeric index".to_owned())?;
            let channels = input
                .get("channel_map")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("sink input {index} has no channel map"))?;
            let volume = input
                .get("volume")
                .and_then(Value::as_object)
                .ok_or_else(|| format!("sink input {index} has no volume map"))?;
            let volumes = channels
                .split(',')
                .map(|channel| {
                    volume
                        .get(channel)
                        .and_then(|value| value.get("value"))
                        .and_then(Value::as_u64)
                        .ok_or_else(|| {
                            format!("sink input {index} has no raw volume for {channel}")
                        })
                })
                .collect::<Result<Vec<_>, _>>()?;
            let properties = input.get("properties").and_then(Value::as_object);
            let identity = [
                "object.serial",
                "application.process.id",
                "application.name",
                "node.name",
                "module-stream-restore.id",
            ]
            .into_iter()
            .map(|key| {
                properties
                    .and_then(|properties| properties.get(key))
                    .and_then(Value::as_str)
                    .unwrap_or("")
            })
            .collect::<Vec<_>>()
            .join("\u{1f}");
            Ok(SavedStream {
                index,
                identity,
                volumes,
                corked: input
                    .get("corked")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect()
}

fn parse_active_sink_inputs(json: &str) -> Result<Vec<SavedStream>, String> {
    Ok(parse_sink_inputs(json)?
        .into_iter()
        .filter(|stream| !stream.corked)
        .collect())
}

pub trait Pactl {
    fn list_sink_inputs(&mut self) -> Result<String, String>;
    fn set_sink_input_volume(&mut self, index: u64, volumes: &[u64]) -> Result<(), String>;
    fn wait(&mut self, duration: Duration);
}

pub struct SystemPactl;

impl Pactl for SystemPactl {
    fn list_sink_inputs(&mut self) -> Result<String, String> {
        let output = Command::new("pactl")
            .args(["-f", "json", "list", "sink-inputs"])
            .output()
            .map_err(|error| format!("cannot run pactl: {error}"))?;
        if output.status.success() {
            String::from_utf8(output.stdout)
                .map_err(|error| format!("pactl returned non-UTF-8 JSON: {error}"))
        } else {
            Err(format!(
                "pactl list sink-inputs failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        }
    }

    fn set_sink_input_volume(&mut self, index: u64, volumes: &[u64]) -> Result<(), String> {
        let mut command = Command::new("pactl");
        command.args(["set-sink-input-volume", &index.to_string()]);
        command.args(volumes.iter().map(u64::to_string));
        let output = command
            .output()
            .map_err(|error| format!("cannot run pactl: {error}"))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "pactl set-sink-input-volume {index} failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        }
    }

    fn wait(&mut self, duration: Duration) {
        thread::sleep(duration);
    }
}

fn fade_frame(from: &[u64], to: &[u64], step: u64) -> Vec<u64> {
    from.iter()
        .zip(to)
        .map(|(from, to)| {
            let delta = *to as i128 - *from as i128;
            (*from as i128 + delta * step as i128 / FADE_STEPS as i128) as u64
        })
        .collect()
}

pub struct PactlAudioControl<P = SystemPactl> {
    pactl: P,
    state_path: PathBuf,
    fraction: f64,
}

impl<P: Pactl> PactlAudioControl<P> {
    fn new(pactl: P, state_path: PathBuf, fraction: f64) -> Result<Self, String> {
        if !(0.0..=1.0).contains(&fraction) || !fraction.is_finite() {
            return Err(format!(
                "audio ducking fraction must be between 0 and 1, got {fraction}"
            ));
        }
        Ok(Self {
            pactl,
            state_path,
            fraction,
        })
    }

    fn save_snapshot(&self, streams: &[SavedStream]) -> Result<(), String> {
        let temporary = self.state_path.with_extension("json.tmp");
        let bytes = serde_json::to_vec(streams)
            .map_err(|error| format!("cannot serialize audio snapshot: {error}"))?;
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(|error| format!("cannot create {}: {error}", temporary.display()))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("cannot write {}: {error}", temporary.display()))?;
        fs::rename(&temporary, &self.state_path).map_err(|error| {
            format!(
                "cannot publish audio snapshot {}: {error}",
                self.state_path.display()
            )
        })
    }

    fn saved_snapshot(&self) -> Result<Option<Vec<SavedStream>>, String> {
        match fs::read(&self.state_path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|error| format!("invalid audio recovery snapshot: {error}")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!(
                "cannot read audio recovery snapshot {}: {error}",
                self.state_path.display()
            )),
        }
    }

    fn restore_saved(&mut self) -> Result<(), String> {
        let Some(saved) = self.saved_snapshot()? else {
            return Ok(());
        };
        let current = parse_sink_inputs(&self.pactl.list_sink_inputs()?)?;
        let mut recoveries = saved
            .into_iter()
            .filter_map(|stream| {
                current
                    .iter()
                    .find(|candidate| {
                        candidate.index == stream.index && candidate.identity == stream.identity
                    })
                    .map(|candidate| (stream, candidate.volumes.clone(), true))
            })
            .collect::<Vec<_>>();
        let mut failed = Vec::new();
        let mut errors = Vec::new();
        for step in 1..=FADE_STEPS {
            for (stream, from, active) in &mut recoveries {
                if !*active {
                    continue;
                }
                let frame = fade_frame(from, &stream.volumes, step);
                if let Err(fade_error) = self.pactl.set_sink_input_volume(stream.index, &frame) {
                    *active = false;
                    // Always try the exact original after an interrupted fade. If that
                    // also fails, keep only this entry durably for the next retry.
                    match self
                        .pactl
                        .set_sink_input_volume(stream.index, &stream.volumes)
                    {
                        Ok(()) => eprintln!(
                            "codex-agent-overlay: stream {} fade failed but exact audio recovery succeeded: {fade_error}",
                            stream.index
                        ),
                        Err(exact_error) => {
                            errors.push(format!(
                                "stream {} recovery failed: {fade_error}; exact restore failed: {exact_error}",
                                stream.index
                            ));
                            failed.push(stream.clone());
                        }
                    }
                }
            }
            if step < FADE_STEPS && recoveries.iter().any(|(_, _, active)| *active) {
                self.pactl.wait(FADE_STEP_DELAY);
            }
        }
        if failed.is_empty() {
            fs::remove_file(&self.state_path).map_err(|error| {
                format!(
                    "cannot remove audio recovery snapshot {}: {error}",
                    self.state_path.display()
                )
            })?;
        } else {
            self.save_snapshot(&failed)?;
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}

fn ducking_settings(enabled: Option<&str>, fraction: Option<&str>) -> Result<(bool, f64), String> {
    let enabled = match enabled
        .unwrap_or("enabled")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "enabled" | "true" | "1" | "yes" | "on" => true,
        "disabled" | "false" | "0" | "no" | "off" => false,
        value => {
            return Err(format!(
                "invalid CODEX_OVERLAY_AUDIO_DUCKING value {value:?}"
            ));
        }
    };
    let fraction = fraction
        .unwrap_or("0.18")
        .parse::<f64>()
        .map_err(|error| format!("invalid CODEX_OVERLAY_AUDIO_DUCK_FRACTION: {error}"))?;
    if !(0.0..=1.0).contains(&fraction) || !fraction.is_finite() {
        return Err(format!(
            "CODEX_OVERLAY_AUDIO_DUCK_FRACTION must be between 0 and 1, got {fraction}"
        ));
    }
    Ok((enabled, fraction))
}

pub fn ducking_from_environment() -> Result<SpeechDucking<PactlAudioControl<SystemPactl>>, String> {
    let enabled = env::var("CODEX_OVERLAY_AUDIO_DUCKING").ok();
    let fraction = env::var("CODEX_OVERLAY_AUDIO_DUCK_FRACTION").ok();
    let (enabled, fraction) = ducking_settings(enabled.as_deref(), fraction.as_deref())?;
    let runtime = env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(env::temp_dir);
    let control = PactlAudioControl::new(
        SystemPactl,
        runtime.join("codex-agent-overlay-audio.json"),
        fraction,
    )?;
    SpeechDucking::new(control, enabled)
}

impl<P: Pactl> AudioControl for PactlAudioControl<P> {
    fn recover_stale(&mut self) -> Result<(), String> {
        self.restore_saved()
    }

    fn begin(&mut self) -> Result<(), String> {
        // A previous partial failure may have left the durable snapshot in place.
        // Restore it before taking a new snapshot so the originals are never lost.
        self.restore_saved()?;
        let streams = parse_active_sink_inputs(&self.pactl.list_sink_inputs()?)?;
        if streams.is_empty() {
            return Ok(());
        }
        self.save_snapshot(&streams)?;
        let targets = streams
            .iter()
            .map(|stream| {
                stream
                    .volumes
                    .iter()
                    .map(|volume| (*volume as f64 * self.fraction).round() as u64)
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        for step in 1..=FADE_STEPS {
            for (stream, target) in streams.iter().zip(&targets) {
                let frame = fade_frame(&stream.volumes, target, step);
                if let Err(error) = self.pactl.set_sink_input_volume(stream.index, &frame) {
                    let recovery = self.restore_saved();
                    return Err(match recovery {
                        Ok(()) => error,
                        Err(recovery) => format!("{error}; recovery also failed: {recovery}"),
                    });
                }
            }
            if step < FADE_STEPS {
                self.pactl.wait(FADE_STEP_DELAY);
            }
        }
        Ok(())
    }

    fn restore(&mut self) -> Result<(), String> {
        self.restore_saved()
    }
}

pub trait AudioControl {
    fn recover_stale(&mut self) -> Result<(), String>;
    fn begin(&mut self) -> Result<(), String>;
    fn restore(&mut self) -> Result<(), String>;
}

pub struct SpeechDucking<C: AudioControl> {
    control: C,
    enabled: bool,
    active: bool,
}

impl<C: AudioControl> SpeechDucking<C> {
    pub fn new(mut control: C, enabled: bool) -> Result<Self, String> {
        control.recover_stale()?;
        Ok(Self {
            control,
            enabled,
            active: false,
        })
    }

    pub fn before_playback(&mut self) -> Result<(), String> {
        if self.enabled && !self.active {
            self.control.begin()?;
            self.active = true;
        }
        Ok(())
    }

    /// Marks that another utterance is replacing the current one. The active
    /// snapshot deliberately remains in force until the replacement finishes.
    pub fn replacement(&mut self) {}

    pub fn error(&mut self) -> Result<(), String> {
        self.finish()
    }

    pub fn finish(&mut self) -> Result<(), String> {
        if self.active {
            self.control.restore()?;
            self.active = false;
        }
        Ok(())
    }
}

impl<C: AudioControl> Drop for SpeechDucking<C> {
    fn drop(&mut self) {
        if let Err(error) = self.finish() {
            eprintln!("codex-agent-overlay: failed to restore background audio: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct FakeAudio {
        events: Arc<Mutex<Vec<&'static str>>>,
    }

    impl AudioControl for FakeAudio {
        fn recover_stale(&mut self) -> Result<(), String> {
            self.events.lock().unwrap().push("recover");
            Ok(())
        }

        fn begin(&mut self) -> Result<(), String> {
            self.events.lock().unwrap().push("begin");
            Ok(())
        }

        fn restore(&mut self) -> Result<(), String> {
            self.events.lock().unwrap().push("restore");
            Ok(())
        }
    }

    #[test]
    fn normal_playback_ducks_then_restores_other_audio() {
        let control = FakeAudio::default();
        let events = control.events.clone();
        let mut ducking = SpeechDucking::new(control, true).unwrap();

        ducking.before_playback().unwrap();
        ducking.finish().unwrap();

        assert_eq!(*events.lock().unwrap(), ["recover", "begin", "restore"]);
    }

    #[test]
    fn replacement_speech_keeps_background_ducked_without_pumping() {
        let control = FakeAudio::default();
        let events = control.events.clone();
        let mut ducking = SpeechDucking::new(control, true).unwrap();

        ducking.before_playback().unwrap();
        ducking.replacement();
        ducking.before_playback().unwrap();
        ducking.finish().unwrap();

        assert_eq!(*events.lock().unwrap(), ["recover", "begin", "restore"]);
    }

    #[test]
    fn playback_error_restores_background_audio() {
        let control = FakeAudio::default();
        let events = control.events.clone();
        let mut ducking = SpeechDucking::new(control, true).unwrap();

        ducking.before_playback().unwrap();
        ducking.error().unwrap();

        assert_eq!(*events.lock().unwrap(), ["recover", "begin", "restore"]);
    }

    #[test]
    fn disabled_mode_recovers_stale_state_but_does_not_duck_new_playback() {
        let control = FakeAudio::default();
        let events = control.events.clone();
        let mut ducking = SpeechDucking::new(control, false).unwrap();

        ducking.before_playback().unwrap();
        ducking.finish().unwrap();

        assert_eq!(*events.lock().unwrap(), ["recover"]);
    }

    #[test]
    fn dropping_active_ducking_restores_audio_after_cancellation_or_shutdown() {
        let control = FakeAudio::default();
        let events = control.events.clone();
        {
            let mut ducking = SpeechDucking::new(control, true).unwrap();
            ducking.before_playback().unwrap();
        }

        assert_eq!(*events.lock().unwrap(), ["recover", "begin", "restore"]);
    }

    #[test]
    fn pipewire_snapshot_contains_only_active_output_streams_with_raw_channel_volumes() {
        let streams = parse_active_sink_inputs(
            r#"[
              {"index":41,"corked":false,"channel_map":"front-left,front-right",
               "volume":{"front-left":{"value":58995},"front-right":{"value":32768}},
               "properties":{"application.process.id":"123","node.name":"Music"}},
              {"index":42,"corked":true,"channel_map":"mono",
               "volume":{"mono":{"value":65536}},"properties":{"node.name":"Paused"}}
            ]"#,
        )
        .unwrap();

        assert_eq!(streams.len(), 1);
        assert_eq!(streams[0].index, 41);
        assert_eq!(streams[0].volumes, [58995, 32768]);
    }

    #[derive(Clone)]
    struct FakePactl {
        listing: String,
        commands: Arc<Mutex<Vec<(u64, Vec<u64>)>>>,
        waits: Arc<Mutex<Vec<Duration>>>,
    }

    impl Pactl for FakePactl {
        fn list_sink_inputs(&mut self) -> Result<String, String> {
            Ok(self.listing.clone())
        }

        fn set_sink_input_volume(&mut self, index: u64, volumes: &[u64]) -> Result<(), String> {
            self.commands
                .lock()
                .unwrap()
                .push((index, volumes.to_vec()));
            Ok(())
        }

        fn wait(&mut self, duration: Duration) {
            self.waits.lock().unwrap().push(duration);
        }
    }

    fn temporary_state(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "codex-overlay-audio-{name}-{}-{}.json",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ))
    }

    #[test]
    fn pactl_controller_attenuates_then_restores_each_streams_exact_channel_volumes() {
        let listing = r#"[{"index":41,"corked":false,"channel_map":"front-left,front-right",
            "volume":{"front-left":{"value":50000},"front-right":{"value":30000}},
            "properties":{"application.process.id":"123","node.name":"Music"}}]"#;
        let commands = Arc::new(Mutex::new(Vec::new()));
        let waits = Arc::new(Mutex::new(Vec::new()));
        let state = temporary_state("normal");
        let _ = std::fs::remove_file(&state);
        let pactl = FakePactl {
            listing: listing.into(),
            commands: commands.clone(),
            waits: waits.clone(),
        };
        let mut control = PactlAudioControl::new(pactl, state.clone(), 0.18).unwrap();

        control.begin().unwrap();
        control.restore().unwrap();

        let commands = commands.lock().unwrap();
        assert_eq!(commands.len(), 10);
        assert_eq!(commands[4], (41, vec![9000, 5400]));
        assert_eq!(commands[9], (41, vec![50000, 30000]));
        assert!(!state.exists());
    }

    #[test]
    fn stale_snapshot_is_recovered_even_when_the_stream_became_corked() {
        let listing = r#"[{"index":41,"corked":true,"channel_map":"front-left,front-right",
            "volume":{"front-left":{"value":9000},"front-right":{"value":5400}},
            "properties":{"application.process.id":"123","node.name":"Music"}}]"#;
        let current = parse_sink_inputs(listing).unwrap().remove(0);
        let saved = SavedStream {
            volumes: vec![50000, 30000],
            ..current
        };
        let commands = Arc::new(Mutex::new(Vec::new()));
        let waits = Arc::new(Mutex::new(Vec::new()));
        let state = temporary_state("stale");
        let _ = std::fs::remove_file(&state);
        std::fs::write(&state, serde_json::to_vec(&vec![saved]).unwrap()).unwrap();
        let pactl = FakePactl {
            listing: listing.into(),
            commands: commands.clone(),
            waits: waits.clone(),
        };
        let mut control = PactlAudioControl::new(pactl, state.clone(), 0.18).unwrap();

        control.recover_stale().unwrap();

        assert_eq!(
            *commands.lock().unwrap(),
            [
                (41, vec![17200, 10320]),
                (41, vec![25400, 15240]),
                (41, vec![33600, 20160]),
                (41, vec![41800, 25080]),
                (41, vec![50000, 30000]),
            ]
        );
        assert_eq!(*waits.lock().unwrap(), [Duration::from_millis(40); 4]);
        assert!(!state.exists());
    }

    #[test]
    fn attenuation_uses_intermediate_frames_and_injected_timing() {
        let listing = r#"[{"index":41,"corked":false,"channel_map":"front-left,front-right",
            "volume":{"front-left":{"value":50000},"front-right":{"value":30000}},
            "properties":{"application.process.id":"123","node.name":"Music"}}]"#;
        let commands = Arc::new(Mutex::new(Vec::new()));
        let waits = Arc::new(Mutex::new(Vec::new()));
        let state = temporary_state("fade-down");
        let _ = std::fs::remove_file(&state);
        let pactl = FakePactl {
            listing: listing.into(),
            commands: commands.clone(),
            waits: waits.clone(),
        };
        let mut control = PactlAudioControl::new(pactl, state.clone(), 0.18).unwrap();

        control.begin().unwrap();

        assert_eq!(
            *commands.lock().unwrap(),
            [
                (41, vec![41800, 25080]),
                (41, vec![33600, 20160]),
                (41, vec![25400, 15240]),
                (41, vec![17200, 10320]),
                (41, vec![9000, 5400]),
            ]
        );
        assert_eq!(*waits.lock().unwrap(), [Duration::from_millis(40); 4]);
        let _ = std::fs::remove_file(state);
    }

    #[test]
    fn multiple_streams_share_one_short_fade_envelope() {
        let listing = r#"[
          {"index":41,"corked":false,"channel_map":"mono","volume":{"mono":{"value":50000}},
           "properties":{"object.serial":"41","node.name":"Music A"}},
          {"index":42,"corked":false,"channel_map":"mono","volume":{"mono":{"value":40000}},
           "properties":{"object.serial":"42","node.name":"Music B"}}
        ]"#;
        let commands = Arc::new(Mutex::new(Vec::new()));
        let waits = Arc::new(Mutex::new(Vec::new()));
        let state = temporary_state("multi-fade");
        let _ = std::fs::remove_file(&state);
        let pactl = FakePactl {
            listing: listing.into(),
            commands,
            waits: waits.clone(),
        };
        let mut control = PactlAudioControl::new(pactl, state.clone(), 0.18).unwrap();

        control.begin().unwrap();

        assert_eq!(*waits.lock().unwrap(), [Duration::from_millis(40); 4]);
        let _ = std::fs::remove_file(state);
    }

    struct SequencePactl {
        listings: VecDeque<String>,
        commands: Arc<Mutex<Vec<(u64, Vec<u64>)>>>,
    }

    impl Pactl for SequencePactl {
        fn list_sink_inputs(&mut self) -> Result<String, String> {
            self.listings
                .pop_front()
                .ok_or_else(|| "unexpected list request".to_owned())
        }

        fn set_sink_input_volume(&mut self, index: u64, volumes: &[u64]) -> Result<(), String> {
            self.commands
                .lock()
                .unwrap()
                .push((index, volumes.to_vec()));
            Ok(())
        }

        fn wait(&mut self, _duration: Duration) {}
    }

    #[test]
    fn a_new_duck_never_overwrites_an_unrecovered_snapshot() {
        let ducked = r#"[{"index":41,"corked":false,"channel_map":"front-left,front-right",
            "volume":{"front-left":{"value":9000},"front-right":{"value":5400}},
            "properties":{"application.process.id":"123","node.name":"Music"}}]"#;
        let original = r#"[{"index":41,"corked":false,"channel_map":"front-left,front-right",
            "volume":{"front-left":{"value":50000},"front-right":{"value":30000}},
            "properties":{"application.process.id":"123","node.name":"Music"}}]"#;
        let current = parse_sink_inputs(ducked).unwrap().remove(0);
        let saved = SavedStream {
            volumes: vec![50000, 30000],
            ..current
        };
        let state = temporary_state("retry");
        let _ = std::fs::remove_file(&state);
        std::fs::write(&state, serde_json::to_vec(&vec![saved]).unwrap()).unwrap();
        let commands = Arc::new(Mutex::new(Vec::new()));
        let pactl = SequencePactl {
            listings: VecDeque::from([ducked.into(), original.into()]),
            commands: commands.clone(),
        };
        let mut control = PactlAudioControl::new(pactl, state.clone(), 0.18).unwrap();

        control.begin().unwrap();

        assert_eq!(
            *commands.lock().unwrap(),
            [
                (41, vec![17200, 10320]),
                (41, vec![25400, 15240]),
                (41, vec![33600, 20160]),
                (41, vec![41800, 25080]),
                (41, vec![50000, 30000]),
                (41, vec![41800, 25080]),
                (41, vec![33600, 20160]),
                (41, vec![25400, 15240]),
                (41, vec![17200, 10320]),
                (41, vec![9000, 5400]),
            ]
        );
        let _ = std::fs::remove_file(state);
    }

    struct FailingRestorePactl {
        listing: String,
        commands: Arc<Mutex<Vec<(u64, Vec<u64>)>>>,
        failing_index: u64,
    }

    impl Pactl for FailingRestorePactl {
        fn list_sink_inputs(&mut self) -> Result<String, String> {
            Ok(self.listing.clone())
        }

        fn set_sink_input_volume(&mut self, index: u64, volumes: &[u64]) -> Result<(), String> {
            self.commands
                .lock()
                .unwrap()
                .push((index, volumes.to_vec()));
            if index == self.failing_index {
                Err("simulated command failure".into())
            } else {
                Ok(())
            }
        }

        fn wait(&mut self, _duration: Duration) {}
    }

    #[test]
    fn restore_attempts_later_streams_and_persists_only_failed_entries() {
        let listing = r#"[
          {"index":41,"corked":false,"channel_map":"mono","volume":{"mono":{"value":9000}},
           "properties":{"object.serial":"41","application.process.id":"123","node.name":"Music A"}},
          {"index":42,"corked":false,"channel_map":"mono","volume":{"mono":{"value":9000}},
           "properties":{"object.serial":"42","application.process.id":"124","node.name":"Music B"}}
        ]"#;
        let mut saved = parse_sink_inputs(listing).unwrap();
        saved[0].volumes = vec![50000];
        saved[1].volumes = vec![40000];
        let state = temporary_state("partial-restore");
        let _ = std::fs::remove_file(&state);
        std::fs::write(&state, serde_json::to_vec(&saved).unwrap()).unwrap();
        let commands = Arc::new(Mutex::new(Vec::new()));
        let pactl = FailingRestorePactl {
            listing: listing.into(),
            commands: commands.clone(),
            failing_index: 41,
        };
        let mut control = PactlAudioControl::new(pactl, state.clone(), 0.18).unwrap();

        let error = control.recover_stale().unwrap_err();

        assert!(error.contains("41"));
        assert!(
            commands
                .lock()
                .unwrap()
                .iter()
                .any(|(index, volumes)| { *index == 41 && volumes == &vec![50000] })
        );
        assert!(
            commands
                .lock()
                .unwrap()
                .iter()
                .any(|(index, volumes)| { *index == 42 && volumes == &vec![40000] })
        );
        let remaining: Vec<SavedStream> =
            serde_json::from_slice(&std::fs::read(&state).unwrap()).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].index, 41);
        let _ = std::fs::remove_file(state);
    }

    struct FailOneFadeFramePactl {
        listings: VecDeque<String>,
        commands: Arc<Mutex<Vec<(u64, Vec<u64>)>>>,
        call: usize,
        fail_on_call: usize,
    }

    impl Pactl for FailOneFadeFramePactl {
        fn list_sink_inputs(&mut self) -> Result<String, String> {
            self.listings
                .pop_front()
                .ok_or_else(|| "unexpected list request".to_owned())
        }

        fn set_sink_input_volume(&mut self, index: u64, volumes: &[u64]) -> Result<(), String> {
            self.call += 1;
            self.commands
                .lock()
                .unwrap()
                .push((index, volumes.to_vec()));
            if self.call == self.fail_on_call {
                Err("one failed fade frame".into())
            } else {
                Ok(())
            }
        }

        fn wait(&mut self, _duration: Duration) {}
    }

    #[test]
    fn successful_exact_fallback_allows_the_next_utterance_to_duck_again() {
        let original = r#"[{"index":41,"corked":false,"channel_map":"mono",
            "volume":{"mono":{"value":50000}},
            "properties":{"object.serial":"41","node.name":"Music"}}]"#;
        let ducked = r#"[{"index":41,"corked":false,"channel_map":"mono",
            "volume":{"mono":{"value":9000}},
            "properties":{"object.serial":"41","node.name":"Music"}}]"#;
        let commands = Arc::new(Mutex::new(Vec::new()));
        let state = temporary_state("exact-fallback");
        let _ = std::fs::remove_file(&state);
        let pactl = FailOneFadeFramePactl {
            listings: VecDeque::from([original.to_owned(), ducked.to_owned(), original.to_owned()]),
            commands: commands.clone(),
            call: 0,
            fail_on_call: 6,
        };
        let control = PactlAudioControl::new(pactl, state.clone(), 0.18).unwrap();
        let mut ducking = SpeechDucking::new(control, true).unwrap();

        ducking.before_playback().unwrap();
        ducking.finish().unwrap();
        ducking.before_playback().unwrap();

        assert_eq!(commands.lock().unwrap().len(), 12);
        let _ = std::fs::remove_file(state);
    }

    #[test]
    fn ducking_settings_default_to_eighteen_percent_and_can_be_disabled() {
        assert_eq!(ducking_settings(None, None).unwrap(), (true, 0.18));
        assert_eq!(
            ducking_settings(Some("disabled"), Some("0.42")).unwrap(),
            (false, 0.42)
        );
        assert!(ducking_settings(None, Some("1.1")).is_err());
    }
}
