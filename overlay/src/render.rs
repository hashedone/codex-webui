use crate::model::{Snapshot, display_rows};
use crate::slots::SlotBook;
use fontdue::{
    Font, FontSettings,
    layout::{CoordinateSystem, Layout, LayoutSettings, TextStyle},
};
use std::{
    env, fs,
    path::{Path, PathBuf},
};

pub const WIDTH: u32 = 460;
pub const HEIGHT: u32 = 680;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Color(u8, u8, u8, u8);

const INK: Color = Color(230, 236, 239, 255);
const MUTED: Color = Color(137, 151, 158, 255);
const FAINT: Color = Color(82, 97, 105, 255);
const GREEN: Color = Color(84, 214, 164, 255);
const AMBER: Color = Color(236, 178, 83, 255);
const RED: Color = Color(240, 103, 114, 255);
const BLUE: Color = Color(95, 168, 255, 255);
const PANEL_RADIUS: i32 = 18;
const PANEL_OUTLINE: Color = Color(105, 125, 135, 92);
const PANEL_FILL: Color = Color(12, 16, 19, 238);
const PANEL_OUTLINE_WIDTH: i32 = 1;

// Keep these explicit and deterministic: the overlay starts before a desktop
// environment is necessarily ready, so font discovery must not depend on an
// external fontconfig process. Arch packages use `noto`, `TTF`, and `OTF` at
// the top level; Debian-family packages commonly use `truetype`.
const SYSTEM_FONT_CANDIDATES: &[&str] = &[
    "/usr/share/fonts/noto/NotoSans-Regular.ttf",
    "/usr/share/fonts/TTF/NotoSans-Regular.ttf",
    "/usr/share/fonts/TTF/Inter-Regular.ttf",
    "/usr/share/fonts/OTF/Inter-Regular.otf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
    "/usr/share/fonts/TTF/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/inter/Inter-Regular.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
];

fn select_font_path(
    configured: Option<PathBuf>,
    exists: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    configured
        .into_iter()
        .chain(SYSTEM_FONT_CANDIDATES.iter().map(PathBuf::from))
        .find(|path| exists(path))
}

pub struct Renderer {
    font: Font,
}

impl Renderer {
    pub fn load() -> Result<Self, String> {
        let configured: Option<PathBuf> = env::var_os("CODEX_OVERLAY_FONT").map(Into::into);
        let path = select_font_path(configured, Path::exists)
            .ok_or("no usable UI font found; set CODEX_OVERLAY_FONT".to_owned())?;
        let bytes = fs::read(&path)
            .map_err(|error| format!("unable to read {}: {error}", path.display()))?;
        let font = Font::from_bytes(bytes, FontSettings::default())
            .map_err(|error| format!("unable to load {}: {error}", path.display()))?;
        Ok(Self { font })
    }

    pub fn draw(
        &self,
        canvas: &mut [u8],
        snapshot: Option<&Snapshot>,
        transport_error: Option<&str>,
        slots: &SlotBook,
    ) {
        canvas.fill(0);
        let (state, state_color) = connection_state(snapshot, transport_error);
        panel(canvas);
        self.text(canvas, 26, 24, 11.0, MUTED, "LOCAL OPERATIONS", 400);
        self.text(canvas, 26, 47, 21.0, INK, "AGENT PRESENCE", 280);

        status_pill(canvas, 362, 42, state, state_color, &self.font);
        fill_rect(canvas, 26, 82, 408, 1, Color(47, 58, 64, 255));

        let Some(snapshot) = snapshot else {
            self.empty(
                canvas,
                "WAITING FOR WEBUI",
                transport_error.unwrap_or("No snapshot received yet"),
            );
            return;
        };
        let rows = display_rows(snapshot, slots);
        if rows.is_empty() {
            self.empty(
                canvas,
                "NO ACTIVE AGENTS",
                transport_error
                    .or(snapshot.error.as_deref())
                    .unwrap_or("Presence sources are connected"),
            );
            return;
        }

        let mut y = 100i32;
        let mut rendered = 0usize;
        for row in &rows {
            let needs = if row.project.is_some() { 70 } else { 48 };
            if y + needs > HEIGHT as i32 - 46 {
                break;
            }
            if let Some(project) = &row.project {
                if rendered > 0 {
                    y += 10;
                }
                let heading = row.slot.map_or_else(
                    || project.to_uppercase(),
                    |slot| format!("[{slot}]  {}", project.to_uppercase()),
                );
                self.text(canvas, 26, y, 10.0, BLUE, &heading, 390);
                y += 24;
            }
            let x = 27 + (row.depth.min(3) as i32 * 22);
            if row.depth > 0 {
                fill_rect(canvas, x - 13, y + 4, 1, 30, Color(47, 60, 66, 255));
            }
            let color = status_color(&row.status);
            circle(canvas, x + 4, y + 10, 4, color);
            let title_color = if row.hierarchy_context { MUTED } else { INK };
            self.text(
                canvas,
                x + 17,
                y,
                14.0,
                title_color,
                &ellipsize(&row.title, 48),
                360 - row.depth as i32 * 22,
            );
            let status = if row.hierarchy_context {
                "context"
            } else {
                status_label(&row.status)
            };
            self.text(
                canvas,
                x + 17,
                y + 22,
                10.0,
                MUTED,
                &format!("{}  ·  {status}", row.detail),
                350,
            );
            y += 48;
            rendered += 1;
        }
        if rendered < rows.len() {
            self.text(
                canvas,
                27,
                HEIGHT as i32 - 57,
                10.0,
                MUTED,
                &format!("+ {} MORE AGENTS", rows.len() - rendered),
                300,
            );
        }
        fill_rect(
            canvas,
            26,
            HEIGHT as i32 - 36,
            408,
            1,
            Color(47, 58, 64, 255),
        );
        self.text(
            canvas,
            26,
            HEIGHT as i32 - 25,
            9.5,
            FAINT,
            "READ-ONLY  ·  INPUT PASSES THROUGH",
            400,
        );
    }

    fn empty(&self, canvas: &mut [u8], title: &str, detail: &str) {
        self.text(canvas, 26, 119, 13.0, MUTED, title, 390);
        self.text(canvas, 26, 145, 11.0, FAINT, &ellipsize(detail, 58), 400);
        fill_rect(
            canvas,
            26,
            HEIGHT as i32 - 36,
            408,
            1,
            Color(47, 58, 64, 255),
        );
        self.text(
            canvas,
            26,
            HEIGHT as i32 - 25,
            9.5,
            FAINT,
            "READ-ONLY  ·  INPUT PASSES THROUGH",
            400,
        );
    }

    fn text(
        &self,
        canvas: &mut [u8],
        x: i32,
        y: i32,
        px: f32,
        color: Color,
        text: &str,
        max_width: i32,
    ) {
        let mut layout = Layout::new(CoordinateSystem::PositiveYDown);
        layout.reset(&LayoutSettings {
            x: x as f32,
            y: y as f32,
            max_width: None,
            max_height: None,
            ..LayoutSettings::default()
        });
        layout.append(&[&self.font], &TextStyle::new(text, px, 0));
        for glyph in layout.glyphs() {
            let (metrics, bitmap) = self.font.rasterize_config(glyph.key);
            for gy in 0..metrics.height {
                for gx in 0..metrics.width {
                    let dx = glyph.x as i32 + gx as i32;
                    let dy = glyph.y as i32 + gy as i32;
                    if dx >= x + max_width {
                        continue;
                    }
                    let alpha = bitmap[gy * metrics.width + gx];
                    blend(
                        canvas,
                        dx,
                        dy,
                        Color(
                            color.0,
                            color.1,
                            color.2,
                            ((alpha as u16 * color.3 as u16) / 255) as u8,
                        ),
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AMBER, FAINT, GREEN, HEIGHT, PANEL_FILL, PANEL_OUTLINE, RED, SYSTEM_FONT_CANDIDATES, WIDTH,
        connection_state, panel, select_font_path,
    };
    use crate::model::Snapshot;
    use std::path::{Path, PathBuf};

    #[test]
    fn configured_font_has_priority_over_system_candidates() {
        let configured = PathBuf::from("/custom/overlay.ttf");
        let first_system = Path::new(SYSTEM_FONT_CANDIDATES[0]);

        let selected = select_font_path(Some(configured.clone()), |path| {
            path == configured || path == first_system
        });

        assert_eq!(selected, Some(configured));
    }

    #[test]
    fn selects_first_existing_system_candidate_in_declared_order() {
        let earlier = Path::new(SYSTEM_FONT_CANDIDATES[1]);
        let later = Path::new(SYSTEM_FONT_CANDIDATES[4]);

        let selected = select_font_path(None, |path| path == earlier || path == later);

        assert_eq!(selected.as_deref(), Some(earlier));
    }

    #[test]
    fn skips_missing_configured_font_before_system_fallback() {
        let configured = PathBuf::from("/custom/missing.ttf");
        let system = Path::new(SYSTEM_FONT_CANDIDATES[0]);

        let selected = select_font_path(Some(configured), |path| path == system);

        assert_eq!(selected.as_deref(), Some(system));
    }

    #[test]
    fn connection_state_drives_pill_palette() {
        let live = Snapshot {
            connected: true,
            ..Snapshot::default()
        };
        let stale = Snapshot {
            connected: true,
            stale: true,
            ..Snapshot::default()
        };

        assert_eq!(connection_state(Some(&live), None), ("LIVE", GREEN));
        assert_eq!(connection_state(Some(&stale), None), ("STALE", AMBER));
        assert_eq!(
            connection_state(None, Some("unavailable")),
            ("OFFLINE", RED)
        );
        assert_eq!(connection_state(None, None), ("WAITING", FAINT));
    }

    #[test]
    fn panel_outline_follows_rounded_panel_geometry() {
        let mut canvas = vec![0; (WIDTH * HEIGHT * 4) as usize];
        panel(&mut canvas);

        let alpha_at = |x: i32, y: i32| canvas[((y as u32 * WIDTH + x as u32) * 4 + 3) as usize];
        let center_x = WIDTH as i32 / 2;
        let center_y = HEIGHT as i32 / 2;

        assert_eq!(alpha_at(0, 0), 0, "outer corner stays transparent");
        assert_eq!(alpha_at(5, 6), PANEL_OUTLINE.3);
        assert_eq!(alpha_at(6, 6), PANEL_FILL.3);
        assert_eq!(alpha_at(center_x, 0), PANEL_OUTLINE.3);
        assert_eq!(alpha_at(center_x, 1), PANEL_FILL.3);
        assert_eq!(alpha_at(0, center_y), PANEL_OUTLINE.3);
        assert_eq!(alpha_at(1, center_y), PANEL_FILL.3);
        assert_eq!(alpha_at(center_x, center_y), PANEL_FILL.3);
        assert_eq!(alpha_at(center_x, HEIGHT as i32 - 1), PANEL_OUTLINE.3);
        assert_eq!(alpha_at(WIDTH as i32 - 1, center_y), PANEL_OUTLINE.3);
    }
}

fn connection_state(
    snapshot: Option<&Snapshot>,
    transport_error: Option<&str>,
) -> (&'static str, Color) {
    if transport_error.is_some() {
        ("OFFLINE", RED)
    } else if snapshot.is_none() {
        ("WAITING", FAINT)
    } else if snapshot.is_some_and(|value| value.stale || !value.connected) {
        ("STALE", AMBER)
    } else {
        ("LIVE", GREEN)
    }
}

fn panel(canvas: &mut [u8]) {
    rounded_rect(
        canvas,
        0,
        0,
        WIDTH as i32,
        HEIGHT as i32,
        PANEL_RADIUS,
        PANEL_OUTLINE,
    );
    replace_rounded_rect(
        canvas,
        PANEL_OUTLINE_WIDTH,
        PANEL_OUTLINE_WIDTH,
        WIDTH as i32 - PANEL_OUTLINE_WIDTH * 2,
        HEIGHT as i32 - PANEL_OUTLINE_WIDTH * 2,
        PANEL_RADIUS - PANEL_OUTLINE_WIDTH,
        PANEL_FILL,
    );
}

fn ellipsize(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_owned();
    }
    let mut value: String = text.chars().take(max_chars.saturating_sub(1)).collect();
    value.push('…');
    value
}

fn status_label(status: &str) -> &'static str {
    match status {
        "active" | "inProgress" => "working",
        "completed" => "complete",
        "failed" => "failed",
        "interrupted" => "interrupted",
        "notLoaded" | "idle" => "idle",
        _ => "unknown",
    }
}

fn status_color(status: &str) -> Color {
    match status {
        "active" | "inProgress" => GREEN,
        "completed" => BLUE,
        "failed" => RED,
        "interrupted" => AMBER,
        _ => FAINT,
    }
}

fn status_pill(canvas: &mut [u8], x: i32, y: i32, text: &str, color: Color, font: &Font) {
    rounded_rect(
        canvas,
        x,
        y,
        72,
        24,
        12,
        Color(color.0, color.1, color.2, 30),
    );
    circle(canvas, x + 13, y + 12, 3, color);
    let renderer = Renderer { font: font.clone() };
    renderer.text(canvas, x + 23, y + 6, 9.5, color, text, 44);
}

fn blend(canvas: &mut [u8], x: i32, y: i32, source: Color) {
    if x < 0 || y < 0 || x >= WIDTH as i32 || y >= HEIGHT as i32 || source.3 == 0 {
        return;
    }
    let index = ((y as u32 * WIDTH + x as u32) * 4) as usize;
    let da = canvas[index + 3] as u16;
    let sa = source.3 as u16;
    let inv = 255 - sa;
    let out_a = sa + (da * inv + 127) / 255;
    for (offset, channel) in [(0, source.2), (1, source.1), (2, source.0)] {
        let dst = canvas[index + offset] as u16;
        let src_premultiplied = channel as u16 * sa / 255;
        canvas[index + offset] = (src_premultiplied + (dst * inv + 127) / 255).min(255) as u8;
    }
    canvas[index + 3] = out_a.min(255) as u8;
}

fn fill_rect(canvas: &mut [u8], x: i32, y: i32, width: i32, height: i32, color: Color) {
    for py in y.max(0)..(y + height).min(HEIGHT as i32) {
        for px in x.max(0)..(x + width).min(WIDTH as i32) {
            blend(canvas, px, py, color);
        }
    }
}

fn rounded_rect(
    canvas: &mut [u8],
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    radius: i32,
    color: Color,
) {
    for py in y..y + height {
        for px in x..x + width {
            let dx = if px < x + radius {
                x + radius - px
            } else if px >= x + width - radius {
                px - (x + width - radius - 1)
            } else {
                0
            };
            let dy = if py < y + radius {
                y + radius - py
            } else if py >= y + height - radius {
                py - (y + height - radius - 1)
            } else {
                0
            };
            if dx * dx + dy * dy <= radius * radius {
                blend(canvas, px, py, color);
            }
        }
    }
}

fn replace_rounded_rect(
    canvas: &mut [u8],
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    radius: i32,
    color: Color,
) {
    for py in y..y + height {
        for px in x..x + width {
            let dx = if px < x + radius {
                x + radius - px
            } else if px >= x + width - radius {
                px - (x + width - radius - 1)
            } else {
                0
            };
            let dy = if py < y + radius {
                y + radius - py
            } else if py >= y + height - radius {
                py - (y + height - radius - 1)
            } else {
                0
            };
            if dx * dx + dy * dy <= radius * radius {
                let index = ((py as u32 * WIDTH + px as u32) * 4) as usize;
                for (offset, channel) in [(0, color.2), (1, color.1), (2, color.0)] {
                    canvas[index + offset] = (channel as u16 * color.3 as u16 / 255) as u8;
                }
                canvas[index + 3] = color.3;
            }
        }
    }
}

fn circle(canvas: &mut [u8], cx: i32, cy: i32, radius: i32, color: Color) {
    for y in cy - radius..=cy + radius {
        for x in cx - radius..=cx + radius {
            if (x - cx).pow(2) + (y - cy).pow(2) <= radius.pow(2) {
                blend(canvas, x, y, color);
            }
        }
    }
}
