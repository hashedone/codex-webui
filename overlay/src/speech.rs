use std::{
    env,
    process::{Child, Command, Stdio},
    sync::mpsc::{self, Sender},
    thread,
    time::Duration,
};

#[derive(Clone, Debug)]
enum Backend {
    SpeechDispatcher { program: String, locale: String },
    Espeak { program: String, locale: String },
    Disabled,
}

pub struct Speaker {
    sender: Sender<String>,
}

impl Speaker {
    pub fn from_environment() -> Self {
        let locale = env::var("CODEX_OVERLAY_TTS_LOCALE").unwrap_or_else(|_| "pl".to_owned());
        let backend = match env::var("CODEX_OVERLAY_TTS_BACKEND")
            .unwrap_or_else(|_| "spd-say".to_owned())
            .as_str()
        {
            "disabled" | "none" => Backend::Disabled,
            "espeak" | "espeak-ng" => Backend::Espeak {
                program: "espeak-ng".to_owned(),
                locale,
            },
            program => Backend::SpeechDispatcher {
                program: program.to_owned(),
                locale,
            },
        };
        Self::new(backend)
    }

    fn new(backend: Backend) -> Self {
        let (sender, receiver) = mpsc::channel::<String>();
        thread::spawn(move || {
            let mut child: Option<Child> = None;
            while let Ok(mut text) = receiver.recv() {
                for newer in receiver.try_iter() {
                    text = newer;
                }
                cancel(&backend, &mut child);
                child = start(&backend, &text).ok();
                while child.is_some() {
                    match receiver.recv_timeout(Duration::from_millis(100)) {
                        Ok(mut newer) => {
                            for latest in receiver.try_iter() {
                                newer = latest;
                            }
                            cancel(&backend, &mut child);
                            child = start(&backend, &newer).ok();
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            if child
                                .as_mut()
                                .is_some_and(|process| process.try_wait().ok().flatten().is_some())
                            {
                                child = None;
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            cancel(&backend, &mut child);
                            return;
                        }
                    }
                }
            }
        });
        Self { sender }
    }

    pub fn speak(&self, text: String) -> Result<(), String> {
        self.sender
            .send(text)
            .map_err(|_| "speech worker is unavailable".to_owned())
    }
}

fn start(backend: &Backend, text: &str) -> std::io::Result<Child> {
    let mut command = match backend {
        Backend::SpeechDispatcher { program, locale } => {
            let mut command = Command::new(program);
            command.args(["-l", locale, "-w", text]);
            command
        }
        Backend::Espeak { program, locale } => {
            let mut command = Command::new(program);
            command.args(["-v", locale, text]);
            command
        }
        Backend::Disabled => return Err(std::io::Error::other("speech is disabled")),
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
}

fn cancel(backend: &Backend, child: &mut Option<Child>) {
    if let Some(mut process) = child.take() {
        let _ = process.kill();
        let _ = process.wait();
    }
    if let Backend::SpeechDispatcher { program, .. } = backend {
        let _ = Command::new(program)
            .arg("-C")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_backend_accepts_work_without_blocking_caller() {
        let speaker = Speaker::new(Backend::Disabled);
        speaker.speak("status".to_owned()).unwrap();
    }
}
