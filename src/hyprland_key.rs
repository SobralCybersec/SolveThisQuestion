pub(super) fn valid_hyprland_key(key: &str) -> bool {
    key.chars().all(valid_hyprland_character)
}

fn valid_hyprland_character(character: char) -> bool {
    if character.is_ascii_alphanumeric() {
        return true;
    }
    if character == '_' {
        return true;
    }
    character == ':'
}
