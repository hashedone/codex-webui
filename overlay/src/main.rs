mod model;
mod pronunciation;
mod render;
mod slots;
mod speech;

use model::{Snapshot, aggregate_summary, slot_summary};
use render::{HEIGHT, Renderer, WIDTH};
use slots::{SLOT_COUNT, SlotBook};
use smithay_client_toolkit::{
    compositor::{CompositorHandler, CompositorState, Region},
    delegate_registry,
    output::{OutputHandler, OutputState},
    reexports::{calloop::EventLoop, calloop_wayland_source::WaylandSource},
    registry::{ProvidesRegistryState, RegistryState},
    registry_handlers,
    shell::{
        WaylandSurface,
        wlr_layer::{
            Anchor, KeyboardInteractivity, Layer, LayerShell, LayerShellHandler, LayerSurface,
            LayerSurfaceConfigure,
        },
    },
    shm::{Shm, ShmHandler, slot::SlotPool},
};
use speech::Speaker;
use std::{
    env, fs,
    io::{Read, Write},
    os::unix::{
        fs::PermissionsExt,
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    process::ExitCode,
    sync::mpsc::{Receiver, sync_channel},
    thread,
    time::Duration,
};
use wayland_client::{
    Connection, QueueHandle,
    globals::registry_queue_init,
    protocol::{wl_output, wl_shm, wl_surface},
};

const DEFAULT_ENDPOINT: &str = "http://127.0.0.1:19889/api/agents/snapshot";
const POLL_INTERVAL: Duration = Duration::from_millis(1500);
const OVERLAY_TOP_MARGIN: i32 = 48;
const OVERLAY_RIGHT_MARGIN: i32 = 14;

const fn overlay_margins() -> (i32, i32, i32, i32) {
    (OVERLAY_TOP_MARGIN, OVERLAY_RIGHT_MARGIN, 0, 0)
}

fn configure_layer_surface(layer: &LayerSurface) {
    let (top, right, bottom, left) = overlay_margins();
    layer.set_layer(Layer::Overlay);
    layer.set_anchor(Anchor::TOP | Anchor::RIGHT);
    layer.set_keyboard_interactivity(KeyboardInteractivity::None);
    layer.set_exclusive_zone(-1);
    layer.set_margin(top, right, bottom, left);
    layer.set_size(WIDTH, HEIGHT);
}

#[derive(Debug)]
struct Options {
    endpoint: String,
    socket: PathBuf,
    hidden: bool,
    slots: PathBuf,
}

enum Mode {
    Run(Options),
    Control { command: String, socket: PathBuf },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ControlRequest {
    Toggle,
    Show,
    Hide,
    Status,
    ReadSlot(u8),
    ReadSummary,
}

fn parse_control_request(value: &str) -> Result<ControlRequest, &'static str> {
    let mut words = value.split_whitespace();
    let request = match (words.next(), words.next()) {
        (Some("toggle"), None) => ControlRequest::Toggle,
        (Some("show"), None) => ControlRequest::Show,
        (Some("hide"), None) => ControlRequest::Hide,
        (Some("status"), None) => ControlRequest::Status,
        (Some("read-summary"), None) => ControlRequest::ReadSummary,
        (Some("read-slot"), Some(slot)) if words.next().is_none() => {
            let slot = slot.parse::<u8>().map_err(|_| "invalid-slot")?;
            if !(1..=SLOT_COUNT).contains(&slot) {
                return Err("invalid-slot");
            }
            ControlRequest::ReadSlot(slot)
        }
        _ => return Err("unknown-command"),
    };
    Ok(request)
}

fn default_socket() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("CODEX_OVERLAY_SOCKET") {
        return Ok(path.into());
    }
    let runtime = env::var_os("XDG_RUNTIME_DIR").ok_or("XDG_RUNTIME_DIR is not set")?;
    Ok(PathBuf::from(runtime).join("codex-agent-overlay.sock"))
}

fn default_slots() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("CODEX_OVERLAY_SLOTS") {
        return Ok(path.into());
    }
    if let Some(path) = env::var_os("XDG_STATE_HOME") {
        return Ok(PathBuf::from(path).join("codex-webui/agent-overlay-slots.json"));
    }
    let home = env::var_os("HOME").ok_or("HOME and XDG_STATE_HOME are not set")?;
    Ok(PathBuf::from(home).join(".local/state/codex-webui/agent-overlay-slots.json"))
}

fn parse_args() -> Result<Mode, String> {
    let mut args = env::args().skip(1).peekable();
    if args.peek().is_some_and(|value| {
        matches!(
            value.as_str(),
            "toggle" | "show" | "hide" | "status" | "read-slot" | "read-summary"
        )
    }) {
        let mut command = args.next().unwrap();
        if command == "read-slot" {
            let slot = args
                .next()
                .ok_or("read-slot requires a number from 1 to 9")?;
            command.push(' ');
            command.push_str(&slot);
        }
        let mut socket = default_socket()?;
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--socket" => socket = args.next().ok_or("--socket requires a path")?.into(),
                _ => return Err(format!("unknown argument: {arg}")),
            }
        }
        return Ok(Mode::Control { command, socket });
    }

    let mut options = Options {
        endpoint: env::var("CODEX_OVERLAY_ENDPOINT").unwrap_or_else(|_| DEFAULT_ENDPOINT.into()),
        socket: default_socket()?,
        hidden: false,
        slots: default_slots()?,
    };
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--endpoint" => options.endpoint = args.next().ok_or("--endpoint requires a URL")?,
            "--socket" => options.socket = args.next().ok_or("--socket requires a path")?.into(),
            "--hidden" => options.hidden = true,
            "--slots" => options.slots = args.next().ok_or("--slots requires a path")?.into(),
            "--help" | "-h" => return Err("usage: codex-agent-overlay [--hidden] [--endpoint URL] [--socket PATH] [--slots PATH]\n       codex-agent-overlay <toggle|show|hide|status|read-summary> [--socket PATH]\n       codex-agent-overlay read-slot <1-9> [--socket PATH]".into()),
            _ => return Err(format!("unknown argument: {arg}")),
        }
    }
    if !is_loopback_endpoint(&options.endpoint) {
        return Err(
            "snapshot endpoint must use plain HTTP on localhost, 127.0.0.1, or [::1]".into(),
        );
    }
    Ok(Mode::Run(options))
}

fn is_loopback_endpoint(endpoint: &str) -> bool {
    let Ok(uri) = endpoint.parse::<http::Uri>() else {
        return false;
    };
    uri.scheme_str() == Some("http")
        && uri
            .authority()
            .is_some_and(|authority| !authority.as_str().contains('@'))
        && matches!(uri.host(), Some("127.0.0.1" | "localhost" | "[::1]"))
}

fn send_control(socket: &Path, command: &str) -> Result<(), String> {
    let mut stream = UnixStream::connect(socket)
        .map_err(|error| format!("overlay is not running at {}: {error}", socket.display()))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .map_err(|error| error.to_string())?;
    stream
        .write_all(command.as_bytes())
        .map_err(|error| error.to_string())?;
    stream
        .shutdown(std::net::Shutdown::Write)
        .map_err(|error| error.to_string())?;
    let mut reply = String::new();
    stream
        .read_to_string(&mut reply)
        .map_err(|error| error.to_string())?;
    let reply = reply.trim();
    if reply.starts_with("error ") {
        return Err(reply.to_owned());
    }
    println!("{reply}");
    Ok(())
}

fn bind_control(path: &Path) -> Result<UnixListener, String> {
    if path.exists() {
        if UnixStream::connect(path).is_ok() {
            return Err(format!("overlay is already running at {}", path.display()));
        }
        fs::remove_file(path)
            .map_err(|error| format!("cannot remove stale socket {}: {error}", path.display()))?;
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let listener = UnixListener::bind(path)
        .map_err(|error| format!("cannot bind {}: {error}", path.display()))?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| error.to_string())?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    Ok(listener)
}

struct SocketGuard(PathBuf);
impl Drop for SocketGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn snapshot_worker(endpoint: String) -> Receiver<Result<Snapshot, String>> {
    let (sender, receiver) = sync_channel(1);
    thread::spawn(move || {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_millis(900)))
            .build();
        let agent: ureq::Agent = config.into();
        loop {
            let result = (|| {
                let body = agent
                    .get(&endpoint)
                    .call()
                    .map_err(|error| format!("snapshot unavailable: {error}"))?
                    .body_mut()
                    .read_to_string()
                    .map_err(|error| format!("snapshot body unavailable: {error}"))?;
                serde_json::from_str::<Snapshot>(&body)
                    .map_err(|error| format!("invalid snapshot: {error}"))
            })();
            let _ = sender.try_send(result);
            thread::sleep(POLL_INTERVAL);
        }
    });
    receiver
}

fn main() -> ExitCode {
    let mode = match parse_args() {
        Ok(mode) => mode,
        Err(error) => {
            eprintln!("codex-agent-overlay: {error}");
            return ExitCode::from(2);
        }
    };
    match mode {
        Mode::Control { command, socket } => match send_control(&socket, &command) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("codex-agent-overlay: {error}");
                ExitCode::FAILURE
            }
        },
        Mode::Run(options) => match run(options) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("codex-agent-overlay: {error}");
                ExitCode::FAILURE
            }
        },
    }
}

fn run(options: Options) -> Result<(), String> {
    let listener = bind_control(&options.socket)?;
    let _guard = SocketGuard(options.socket.clone());
    let receiver = snapshot_worker(options.endpoint);
    let slots = SlotBook::load(options.slots);
    let speaker = Speaker::from_environment();
    let renderer = Renderer::load()?;
    let conn = Connection::connect_to_env()
        .map_err(|error| format!("Wayland connection failed: {error}"))?;
    let (globals, event_queue) =
        registry_queue_init(&conn).map_err(|error| format!("Wayland registry failed: {error}"))?;
    let qh = event_queue.handle();
    let compositor = CompositorState::bind(&globals, &qh)
        .map_err(|error| format!("wl_compositor unavailable: {error}"))?;
    let layer_shell = LayerShell::bind(&globals, &qh)
        .map_err(|error| format!("wlr layer shell unavailable: {error}"))?;
    let shm = Shm::bind(&globals, &qh).map_err(|error| format!("wl_shm unavailable: {error}"))?;
    let surface = compositor.create_surface(&qh);
    let layer = layer_shell.create_layer_surface(
        &qh,
        surface,
        Layer::Overlay,
        Some("codex-agent-overlay"),
        None,
    );
    configure_layer_surface(&layer);
    let empty_region =
        Region::new(&compositor).map_err(|error| format!("input region failed: {error}"))?;
    layer.set_input_region(Some(empty_region.wl_region()));
    layer.commit();

    let pool_size = WIDTH as usize * HEIGHT as usize * 4 * 3;
    let pool = SlotPool::new(pool_size, &shm)
        .map_err(|error| format!("shared-memory pool failed: {error}"))?;
    let mut state = App {
        registry_state: RegistryState::new(&globals),
        output_state: OutputState::new(&globals, &qh),
        shm,
        layer,
        pool,
        renderer,
        listener,
        receiver,
        surface: SurfaceLifecycle::new(!options.hidden),
        exit: false,
        snapshot: None,
        transport_error: None,
        redraw: true,
        slots,
        speaker,
    };
    let mut event_loop: EventLoop<App> = EventLoop::try_new().map_err(|error| error.to_string())?;
    WaylandSource::new(conn, event_queue)
        .insert(event_loop.handle())
        .map_err(|error| error.to_string())?;

    while !state.exit {
        event_loop
            .dispatch(Duration::from_millis(100), &mut state)
            .map_err(|error| error.to_string())?;
        state.tick(&qh);
    }
    Ok(())
}

struct App {
    registry_state: RegistryState,
    output_state: OutputState,
    shm: Shm,
    layer: LayerSurface,
    pool: SlotPool,
    renderer: Renderer,
    listener: UnixListener,
    receiver: Receiver<Result<Snapshot, String>>,
    surface: SurfaceLifecycle,
    exit: bool,
    snapshot: Option<Snapshot>,
    transport_error: Option<String>,
    redraw: bool,
    slots: SlotBook,
    speaker: Speaker,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SurfaceAction {
    None,
    Draw,
    RequestConfigure,
    Unmap,
}

/// Tracks requested visibility separately from the layer-surface protocol state.
///
/// Attaching a null buffer unmaps a layer surface. The next map must start with
/// a bufferless commit and wait for a fresh configure before attaching a new
/// buffer, even though the application still considers itself visible.
#[derive(Debug)]
struct SurfaceLifecycle {
    requested_visible: bool,
    configured: bool,
    mapped: bool,
    configure_pending: bool,
}

impl SurfaceLifecycle {
    fn new(requested_visible: bool) -> Self {
        Self {
            requested_visible,
            configured: false,
            mapped: false,
            // run() performs the initial bufferless commit before constructing App.
            configure_pending: true,
        }
    }

    fn request_visibility(&mut self, visible: bool) -> SurfaceAction {
        if self.requested_visible == visible {
            return SurfaceAction::None;
        }
        self.requested_visible = visible;

        if !visible {
            if self.mapped {
                self.mapped = false;
                self.configured = false;
                self.configure_pending = false;
                return SurfaceAction::Unmap;
            }
            return SurfaceAction::None;
        }

        if self.configured {
            SurfaceAction::Draw
        } else if self.configure_pending {
            SurfaceAction::None
        } else {
            self.configure_pending = true;
            SurfaceAction::RequestConfigure
        }
    }

    fn configured(&mut self) -> SurfaceAction {
        self.configure_pending = false;
        self.configured = true;
        if self.requested_visible {
            SurfaceAction::Draw
        } else {
            SurfaceAction::None
        }
    }

    fn mapped(&mut self) {
        self.mapped = true;
    }

    fn should_draw(&self) -> bool {
        self.requested_visible && self.configured
    }
}

impl App {
    fn tick(&mut self, qh: &QueueHandle<Self>) {
        while let Ok(result) = self.receiver.try_recv() {
            match result {
                Ok(snapshot) => {
                    if let Err(error) = self.slots.update(&snapshot) {
                        eprintln!("codex-agent-overlay: {error}");
                    }
                    self.snapshot = Some(snapshot);
                    self.transport_error = None;
                }
                Err(error) => self.transport_error = Some(error),
            }
            self.redraw = true;
        }
        loop {
            let Ok((mut stream, _)) = self.listener.accept() else {
                break;
            };
            let _ = stream.set_read_timeout(Some(Duration::from_millis(100)));
            let mut command = String::new();
            let response = match (&mut stream).take(64).read_to_string(&mut command) {
                Ok(_) => match parse_control_request(&command) {
                    Ok(ControlRequest::Toggle) => {
                        self.set_visible(!self.surface.requested_visible);
                        self.state_line()
                    }
                    Ok(ControlRequest::Show) => {
                        self.set_visible(true);
                        self.state_line()
                    }
                    Ok(ControlRequest::Hide) => {
                        self.set_visible(false);
                        self.state_line()
                    }
                    Ok(ControlRequest::Status) => self.state_line(),
                    Ok(ControlRequest::ReadSummary) => self.read_summary(),
                    Ok(ControlRequest::ReadSlot(slot)) => self.read_slot(slot),
                    Err(error) => format!("error {error}\n"),
                },
                Err(error) => format!("error {error}\n"),
            };
            let _ = stream.write_all(response.as_bytes());
        }
        if self.redraw && self.surface.should_draw() {
            self.draw(qh);
        }
    }

    fn read_slot(&self, slot: u8) -> String {
        let Some(snapshot) = self.snapshot.as_ref() else {
            return "error snapshot-unavailable\n".to_owned();
        };
        let Some(summary) = slot_summary(snapshot, &self.slots, slot) else {
            return format!("error empty-slot {slot}\n");
        };
        match self.speaker.speak(summary) {
            Ok(()) => format!("ok speaking-slot {slot}\n"),
            Err(error) => format!("error {error}\n"),
        }
    }

    fn read_summary(&self) -> String {
        let Some(snapshot) = self.snapshot.as_ref() else {
            return "error snapshot-unavailable\n".to_owned();
        };
        match self.speaker.speak(aggregate_summary(snapshot, &self.slots)) {
            Ok(()) => "ok speaking-summary\n".to_owned(),
            Err(error) => format!("error {error}\n"),
        }
    }

    fn state_line(&self) -> String {
        let visibility = if self.surface.requested_visible {
            "visible"
        } else {
            "hidden"
        };
        let health = if self.transport_error.is_some() {
            "offline"
        } else if self
            .snapshot
            .as_ref()
            .is_some_and(|snapshot| snapshot.stale || !snapshot.connected)
        {
            "stale"
        } else if self.snapshot.is_some() {
            "live"
        } else {
            "waiting"
        };
        let count = self
            .snapshot
            .as_ref()
            .map_or(0, |snapshot| snapshot.tasks.len());
        format!("{visibility} {health} {count}\n")
    }

    fn set_visible(&mut self, visible: bool) {
        match self.surface.request_visibility(visible) {
            SurfaceAction::None => {}
            SurfaceAction::Draw => {
                self.redraw = true;
            }
            SurfaceAction::RequestConfigure => {
                // A null-buffer commit unmapped the surface. Remapping starts
                // from the layer role defaults, so restore every role property
                // before the fresh bufferless commit and configure handshake.
                configure_layer_surface(&self.layer);
                self.layer.commit();
            }
            SurfaceAction::Unmap => {
                self.layer.wl_surface().attach(None, 0, 0);
                self.layer.commit();
            }
        }
    }

    fn draw(&mut self, _qh: &QueueHandle<Self>) {
        let stride = WIDTH as i32 * 4;
        let Ok((buffer, canvas)) = self.pool.create_buffer(
            WIDTH as i32,
            HEIGHT as i32,
            stride,
            wl_shm::Format::Argb8888,
        ) else {
            return;
        };
        self.renderer.draw(
            canvas,
            self.snapshot.as_ref(),
            self.transport_error.as_deref(),
            &self.slots,
        );
        self.layer
            .wl_surface()
            .damage_buffer(0, 0, WIDTH as i32, HEIGHT as i32);
        if buffer.attach_to(self.layer.wl_surface()).is_ok() {
            self.layer.commit();
            self.surface.mapped();
            self.redraw = false;
        }
    }
}

impl CompositorHandler for App {
    fn scale_factor_changed(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &wl_surface::WlSurface,
        _: i32,
    ) {
        self.redraw = true;
    }
    fn transform_changed(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &wl_surface::WlSurface,
        _: wl_output::Transform,
    ) {
        self.redraw = true;
    }
    fn frame(&mut self, _: &Connection, qh: &QueueHandle<Self>, _: &wl_surface::WlSurface, _: u32) {
        if self.redraw && self.surface.should_draw() {
            self.draw(qh);
        }
    }
    fn surface_enter(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &wl_surface::WlSurface,
        _: &wl_output::WlOutput,
    ) {
    }
    fn surface_leave(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &wl_surface::WlSurface,
        _: &wl_output::WlOutput,
    ) {
    }
}

impl LayerShellHandler for App {
    fn closed(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &LayerSurface) {
        self.exit = true;
    }
    fn configure(
        &mut self,
        _: &Connection,
        qh: &QueueHandle<Self>,
        _: &LayerSurface,
        _: LayerSurfaceConfigure,
        _: u32,
    ) {
        if self.surface.configured() == SurfaceAction::Draw {
            self.draw(qh);
        }
    }
}

impl OutputHandler for App {
    fn output_state(&mut self) -> &mut OutputState {
        &mut self.output_state
    }
    fn new_output(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_output::WlOutput) {}
    fn update_output(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_output::WlOutput) {}
    fn output_destroyed(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_output::WlOutput) {}
}

impl ShmHandler for App {
    fn shm_state(&mut self) -> &mut Shm {
        &mut self.shm
    }
}
delegate_registry!(App);
impl ProvidesRegistryState for App {
    fn registry(&mut self) -> &mut RegistryState {
        &mut self.registry_state
    }
    registry_handlers![OutputState];
}
smithay_client_toolkit::delegate_dispatch2!(App);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlay_sits_below_and_aligns_with_waybar() {
        assert_eq!(overlay_margins(), (48, 14, 0, 0));
    }

    #[test]
    fn accepts_only_explicit_loopback_http_endpoints() {
        assert!(is_loopback_endpoint(DEFAULT_ENDPOINT));
        assert!(is_loopback_endpoint(
            "http://localhost:8080/api/agents/snapshot"
        ));
        assert!(is_loopback_endpoint(
            "http://[::1]:8080/api/agents/snapshot"
        ));
        assert!(!is_loopback_endpoint(
            "https://example.test/api/agents/snapshot"
        ));
        assert!(!is_loopback_endpoint("http://127.0.0.1.example.test:80/x"));
        assert!(!is_loopback_endpoint("http://127.0.0.1:80@evil.test/x"));
    }

    #[test]
    fn parses_spoken_status_ipc_without_ambiguous_trailing_input() {
        assert_eq!(
            parse_control_request("read-slot 7\n"),
            Ok(ControlRequest::ReadSlot(7))
        );
        assert_eq!(
            parse_control_request("read-summary"),
            Ok(ControlRequest::ReadSummary)
        );
        assert_eq!(parse_control_request("read-slot 0"), Err("invalid-slot"));
        assert_eq!(
            parse_control_request("read-slot 1 extra"),
            Err("unknown-command")
        );
    }

    #[test]
    fn initial_hidden_surface_waits_until_explicitly_shown() {
        let mut surface = SurfaceLifecycle::new(false);

        assert_eq!(surface.configured(), SurfaceAction::None);
        assert!(!surface.should_draw());
        assert_eq!(surface.request_visibility(true), SurfaceAction::Draw);
        assert!(surface.should_draw());
        surface.mapped();
        assert!(surface.mapped);
    }

    #[test]
    fn repeated_hide_show_requires_a_fresh_configure_before_each_remap() {
        let mut surface = SurfaceLifecycle::new(true);
        assert_eq!(surface.configured(), SurfaceAction::Draw);
        surface.mapped();

        for _ in 0..3 {
            assert_eq!(surface.request_visibility(false), SurfaceAction::Unmap);
            assert!(!surface.mapped);
            assert!(!surface.should_draw());

            assert_eq!(
                surface.request_visibility(true),
                SurfaceAction::RequestConfigure
            );
            assert!(!surface.should_draw());
            assert_eq!(surface.configured(), SurfaceAction::Draw);
            surface.mapped();
        }
    }

    #[test]
    fn configure_received_while_hidden_never_draws() {
        let mut surface = SurfaceLifecycle::new(true);
        assert_eq!(surface.configured(), SurfaceAction::Draw);
        surface.mapped();
        assert_eq!(surface.request_visibility(false), SurfaceAction::Unmap);
        assert_eq!(
            surface.request_visibility(true),
            SurfaceAction::RequestConfigure
        );
        assert_eq!(surface.request_visibility(false), SurfaceAction::None);

        assert_eq!(surface.configured(), SurfaceAction::None);
        assert!(!surface.should_draw());

        assert_eq!(surface.request_visibility(true), SurfaceAction::Draw);
    }
}
