use serde::Deserialize;
use std::{cmp::Reverse, collections::BTreeMap, env, fs, path::PathBuf};

const POLISH_LETTER_NAMES: &[(&str, &str)] = &[
    ("A", "a"),
    ("B", "be"),
    ("C", "ce"),
    ("D", "de"),
    ("E", "e"),
    ("F", "ef"),
    ("G", "gie"),
    ("H", "ha"),
    ("I", "i"),
    ("J", "jot"),
    ("K", "ka"),
    ("L", "el"),
    ("M", "em"),
    ("N", "en"),
    ("O", "o"),
    ("P", "pe"),
    ("Q", "ku"),
    ("R", "er"),
    ("S", "es"),
    ("T", "te"),
    ("U", "u"),
    ("V", "fał"),
    ("W", "wu"),
    ("X", "iks"),
    ("Y", "igrek"),
    ("Z", "zet"),
];

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct PronunciationFile {
    aliases: BTreeMap<String, String>,
    dictionary: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Default)]
pub struct Pronouncer {
    aliases: Vec<(String, String)>,
    dictionary: BTreeMap<String, String>,
}

impl Pronouncer {
    pub fn from_environment() -> Result<Self, String> {
        let mut config: PronunciationFile =
            serde_json::from_str(include_str!("../pronunciations.json"))
                .map_err(|error| format!("invalid built-in pronunciation file: {error}"))?;
        if let Some(shared) = env::var_os("CODEX_OVERLAY_TTS_PRONUNCIATIONS").map(PathBuf::from) {
            let overrides = read_file(&shared)?;
            config.aliases.extend(overrides.aliases);
            config.dictionary.extend(overrides.dictionary);
        }

        let explicit_user = env::var_os("CODEX_OVERLAY_TTS_ALIASES").map(PathBuf::from);
        let user = explicit_user.clone().or_else(default_user_aliases);
        if let Some(path) = user.filter(|path| path.exists() || explicit_user.is_some()) {
            let overrides = read_file(&path)?;
            config.aliases.extend(overrides.aliases);
            config.dictionary.extend(overrides.dictionary);
        }
        Ok(Self::new(config))
    }

    fn new(config: PronunciationFile) -> Self {
        let mut aliases: Vec<_> = config.aliases.into_iter().collect();
        aliases.sort_by_key(|alias| Reverse(alias.0.chars().count()));
        Self {
            aliases,
            dictionary: config
                .dictionary
                .into_iter()
                .map(|(key, value)| (key.to_lowercase(), value))
                .collect(),
        }
    }

    pub fn prepare(&self, text: &str) -> String {
        let aliased = self
            .aliases
            .iter()
            .fold(text.to_owned(), |value, (name, spoken)| {
                replace_exact_name(&value, name, spoken)
            });
        let separated = separate_identifier_words(&aliased);
        replace_dictionary_and_acronyms(&separated, &self.dictionary)
    }
}

fn read_file(path: &PathBuf) -> Result<PronunciationFile, String> {
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("cannot read pronunciation file {}: {error}", path.display()))?;
    serde_json::from_str(&contents)
        .map_err(|error| format!("invalid pronunciation file {}: {error}", path.display()))
}

fn default_user_aliases() -> Option<PathBuf> {
    if let Some(config) = env::var_os("XDG_CONFIG_HOME") {
        return Some(PathBuf::from(config).join("codex-webui/spoken-names.json"));
    }
    env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".config/codex-webui/spoken-names.json"))
}

fn replace_exact_name(value: &str, name: &str, spoken: &str) -> String {
    if name.is_empty() {
        return value.to_owned();
    }
    let mut result = String::with_capacity(value.len());
    let mut remainder = value;
    while let Some(index) = remainder.find(name) {
        let before = &remainder[..index];
        let after = &remainder[index + name.len()..];
        let left_boundary = before
            .chars()
            .next_back()
            .is_none_or(|c| !c.is_alphanumeric());
        let right_boundary = after.chars().next().is_none_or(|c| !c.is_alphanumeric());
        if left_boundary && right_boundary {
            result.push_str(before);
            result.push_str(spoken);
            remainder = after;
        } else {
            let split = index + name.chars().next().map_or(1, char::len_utf8);
            result.push_str(&remainder[..split]);
            remainder = &remainder[split..];
        }
    }
    result.push_str(remainder);
    result
}

fn separate_identifier_words(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut result = String::with_capacity(value.len());
    for (index, &current) in chars.iter().enumerate() {
        if matches!(current, '-' | '_') {
            if !result.ends_with(' ') {
                result.push(' ');
            }
            continue;
        }
        let previous = index.checked_sub(1).and_then(|i| chars.get(i)).copied();
        let next = chars.get(index + 1).copied();
        let camel_boundary =
            current.is_uppercase() && previous.is_some_and(|c| c.is_lowercase() || c.is_numeric());
        let acronym_boundary = current.is_uppercase()
            && previous.is_some_and(char::is_uppercase)
            && next.is_some_and(char::is_lowercase);
        if (camel_boundary || acronym_boundary) && !result.ends_with(' ') {
            result.push(' ');
        }
        result.push(current);
    }
    result
}

fn replace_dictionary_and_acronyms(value: &str, dictionary: &BTreeMap<String, String>) -> String {
    let mut result = String::with_capacity(value.len());
    let mut word = String::new();
    let flush = |word: &mut String, result: &mut String| {
        if word.is_empty() {
            return;
        }
        if let Some(spoken) = dictionary.get(&word.to_lowercase()) {
            result.push_str(spoken);
        } else if word.len() > 1 && word.chars().all(|c| c.is_ascii_uppercase()) {
            let letters: Vec<&str> = word
                .chars()
                .filter_map(|letter| {
                    POLISH_LETTER_NAMES
                        .iter()
                        .find_map(|(key, spoken)| (*key == letter.to_string()).then_some(*spoken))
                })
                .collect();
            result.push_str(&letters.join(" "));
        } else {
            result.push_str(word);
        }
        word.clear();
    };
    for current in value.chars() {
        if current.is_alphanumeric() {
            word.push(current);
        } else {
            flush(&mut word, &mut result);
            result.push(current);
        }
    }
    flush(&mut word, &mut result);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pronouncer() -> Pronouncer {
        Pronouncer::new(PronunciationFile {
            aliases: BTreeMap::from([
                ("Agent Presence Hub".into(), "ejdżent prezens hab".into()),
                ("ONI Observer".into(), "o en i obzerwer".into()),
                ("codex-webui".into(), "kołdeks łeb ju aj".into()),
            ]),
            dictionary: BTreeMap::from([
                ("overlay".into(), "ołwerlej".into()),
                ("observer".into(), "obzerwer".into()),
            ]),
        })
    }

    #[test]
    fn built_in_map_covers_the_acceptance_names() {
        let config = serde_json::from_str(include_str!("../pronunciations.json")).unwrap();
        let spoken = Pronouncer::new(config)
            .prepare("codex-webui, Agent Presence Hub, ONI Observer, overlay");
        assert_eq!(
            spoken,
            "kołdeks łeb ju aj, ejdżent prezens hab, o en i obzerwer, ołwerlej"
        );
    }

    #[test]
    fn applies_exact_spoken_names_without_touching_surrounding_text() {
        assert_eq!(
            pronouncer().prepare("Projekt codex-webui. Agent Presence Hub i ONI Observer."),
            "Projekt kołdeks łeb ju aj. ejdżent prezens hab i o en i obzerwer."
        );
    }

    #[test]
    fn normalizes_identifier_styles_dictionary_words_and_acronyms() {
        assert_eq!(
            pronouncer().prepare("agent_overlay XMLParser ONI observer"),
            "agent ołwerlej iks em el Parser o en i obzerwer"
        );
    }

    #[test]
    fn aliases_only_match_complete_names() {
        assert_eq!(
            replace_exact_name("my-codex-webui-fork", "codex-webui", "spoken"),
            "my-spoken-fork"
        );
        assert_eq!(
            replace_exact_name("codex-webui2", "codex-webui", "spoken"),
            "codex-webui2"
        );
    }
}
