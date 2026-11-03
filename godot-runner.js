const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const GODOT_CANDIDATE_DIRS = [
  path.join(os.homedir(), "Downloads"),
  path.join(os.homedir(), "Desktop"),
  path.join(os.homedir(), "Documents"),
  path.join(process.env.LOCALAPPDATA || "", "Godot"),
  "C:\\Program Files\\Godot",
  "C:\\Godot",
  "C:\\tools",
];
const EXPORT_PRESET = "Web";
let cachedGodot;

// Prefer the console build so stdout/stderr are captured; fall back to the editor binary.
function findGodot({ refresh = false } = {}) {
  if (cachedGodot !== undefined && !refresh) return cachedGodot;
  const explicit = process.env.GODOT_PATH;
  if (explicit && fs.existsSync(explicit) && fs.statSync(explicit).isFile()) return (cachedGodot = explicit);
  const matches = [];
  const visit = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (/^godot.*\.exe$/i.test(entry.name) && entry.isFile() && !/py4godot/i.test(full)) matches.push(full);
      else if (entry.isDirectory() && depth < 2 && !/node_modules|\.git$/i.test(entry.name)) visit(full, depth + 1);
    }
  };
  if (process.platform === "win32") GODOT_CANDIDATE_DIRS.forEach((dir) => dir && visit(dir, 0));
  matches.sort((a, b) => Number(/console/i.test(b)) - Number(/console/i.test(a)));
  return (cachedGodot = matches[0] || null);
}

function run(godot, args, { timeoutMs = 120_000, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(godot, args, { cwd, windowsHide: true });
    let output = "";
    const collect = (chunk) => { output = (output + chunk.toString("utf8")).slice(-60_000); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => { output += "\nTIMEOUT: Godot did not finish in time."; child.kill(); }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: -1, output: `${output}\nERROR: ${error.message}` }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

// Pulls actionable error lines (with their file:line follow-ups) out of Godot's log.
function extractErrors(output) {
  const lines = output.split(/\r?\n/);
  const errors = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^(SCRIPT ERROR|ERROR|Parse Error|TIMEOUT)\b|Failed to load script|Parse Error/.test(lines[i].trim())) {
      if (/(audio|driver|display|XR|OpenXR|headless|Vulkan|dummy)/i.test(lines[i]) && !/res:\/\//.test(lines[i + 1] || "")) continue;
      errors.push(lines.slice(i, i + 3).map((line) => line.trim()).filter(Boolean).join(" | "));
    }
  }
  return [...new Set(errors)];
}

const STUDIO_AUTOLOAD = `extends Node
# Injected by Traumatic Studios: input actions, procedural sound effects and an automated play-test mode.

var _wav_cache := {}
var _fuzz := false
var _fuzz_timer := 0
var _held := []
const ACTIONS := {
	"move_left": [KEY_LEFT, KEY_A], "move_right": [KEY_RIGHT, KEY_D], "move_up": [KEY_UP, KEY_W], "move_down": [KEY_DOWN, KEY_S],
	"action": [KEY_SPACE, KEY_Z, KEY_J, KEY_ENTER], "action2": [KEY_X, KEY_K, KEY_SHIFT], "pause": [KEY_P, KEY_ESCAPE], "restart": [KEY_R],
}
const PRESETS := {
	"blip": [520.0, 0.07, 0.0, "square", 0.25], "pickup": [660.0, 0.14, 500.0, "triangle", 0.35], "hit": [160.0, 0.14, -90.0, "saw", 0.4],
	"jump": [300.0, 0.16, 280.0, "square", 0.25], "shoot": [880.0, 0.1, -600.0, "square", 0.22], "explode": [110.0, 0.35, -80.0, "noise", 0.5],
	"powerup": [400.0, 0.35, 700.0, "triangle", 0.35], "lose": [300.0, 0.6, -250.0, "saw", 0.4], "win": [500.0, 0.6, 500.0, "triangle", 0.4],
}

func _ready() -> void:
	for action in ACTIONS:
		if not InputMap.has_action(action):
			InputMap.add_action(action)
		for key in ACTIONS[action]:
			var event := InputEventKey.new()
			event.physical_keycode = key
			InputMap.action_add_event(action, event)
	_fuzz = OS.get_cmdline_user_args().has("--fuzz")

func _process(_delta: float) -> void:
	if not _fuzz:
		return
	_fuzz_timer += 1
	if _fuzz_timer % 6 != 0:
		return
	for action in _held:
		Input.action_release(action)
	_held.clear()
	var names := ACTIONS.keys()
	for i in randi_range(1, 2):
		var action: String = names[randi() % names.size()]
		if action == "pause" or action == "restart":
			continue
		Input.action_press(action)
		_held.append(action)
	if _fuzz_timer % 30 == 0:
		var click := InputEventMouseButton.new()
		click.button_index = MOUSE_BUTTON_LEFT
		click.pressed = true
		click.position = Vector2(randf() * 600.0, randf() * 400.0)
		Input.parse_input_event(click)

func sfx(kind: String = "blip", volume: float = 1.0) -> void:
	var preset: Array = PRESETS.get(kind, PRESETS["blip"])
	if not _wav_cache.has(kind):
		_wav_cache[kind] = _make_wav(preset)
	var player := AudioStreamPlayer.new()
	player.stream = _wav_cache[kind]
	player.volume_db = linear_to_db(clampf(volume, 0.0, 1.0))
	add_child(player)
	player.finished.connect(player.queue_free)
	player.play()

func _make_wav(preset: Array) -> AudioStreamWAV:
	var rate := 22050
	var count := int(rate * float(preset[1]))
	var bytes := PackedByteArray()
	bytes.resize(count * 2)
	var phase := 0.0
	for i in count:
		var t := float(i) / float(rate)
		var freq: float = float(preset[0]) + float(preset[2]) * t / float(preset[1])
		phase += maxf(freq, 20.0) / float(rate)
		var wave := 0.0
		match String(preset[3]):
			"square": wave = 1.0 if fmod(phase, 1.0) < 0.5 else -1.0
			"triangle": wave = absf(fmod(phase, 1.0) * 4.0 - 2.0) - 1.0
			"saw": wave = fmod(phase, 1.0) * 2.0 - 1.0
			_: wave = randf() * 2.0 - 1.0
		var sample := int(wave * (1.0 - float(i) / float(count)) * float(preset[4]) * 32767.0) & 0xFFFF
		bytes[i * 2] = sample & 0xFF
		bytes[i * 2 + 1] = (sample >> 8) & 0xFF
	var stream := AudioStreamWAV.new()
	stream.format = AudioStreamWAV.FORMAT_16_BITS
	stream.mix_rate = rate
	stream.data = bytes
	return stream
`;

function projectGodot({ title, width, height }) {
  const safeTitle = String(title).replace(/["\\\n\r]/g, "").slice(0, 60) || "Game";
  return `config_version=5

[application]

config/name="${safeTitle}"
run/main_scene="res://main.tscn"
config/features=PackedStringArray("4.7")

[autoload]

Studio="*res://studio.gd"

[display]

window/size/viewport_width=${width}
window/size/viewport_height=${height}
window/stretch/mode="canvas_items"

[rendering]

renderer/rendering_method="gl_compatibility"
renderer/rendering_method.mobile="gl_compatibility"
textures/canvas_textures/default_texture_filter=0
`;
}

const MAIN_SCENE = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://scripts/main.gd" id="1"]

[node name="Main" type="Node2D"]
script = ExtResource("1")
`;

const EXPORT_PRESETS = `[preset.0]

name="${EXPORT_PRESET}"
platform="Web"
runnable=true
advanced_options=false
dedicated_server=false
custom_features=""
export_filter="all_resources"
include_filter=""
exclude_filter=""
export_path=""
encryption_include_filters=""
encryption_exclude_filters=""
encrypt_pck=false
encrypt_directory=false

[preset.0.options]

custom_template/debug=""
custom_template/release=""
variant/extensions_support=false
variant/thread_support=false
vram_texture_compression/for_desktop=true
vram_texture_compression/for_mobile=false
html/export_icon=true
html/custom_html_shell=""
html/head_include=""
html/canvas_resize_policy=2
html/focus_canvas_on_start=true
html/experimental_virtual_keyboard=false
progressive_web_app/enabled=false
`;

const SAFE_PATH = /^(scripts|scenes|data)\/[a-z0-9_\-/]+\.(gd|tscn|tres|json|gdshader)$/i;
const FORBIDDEN_GD = /\b(OS\.execute|OS\.shell_open|OS\.create_process|HTTPRequest|HTTPClient|TCPServer|StreamPeerTCP|WebSocketPeer|UDPServer|JavaScriptBridge|DirAccess|FileAccess|OS\.kill|ClassDB\.instantiate|Expression\.new|load_threaded)\b/;

// Writes the managed scaffold plus the model's files into dir. Returns problems for any rejected file.
async function writeProject(dir, meta, files) {
  const problems = [];
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(path.join(dir, "scripts"), { recursive: true });
  await fsp.writeFile(path.join(dir, "project.godot"), projectGodot(meta));
  await fsp.writeFile(path.join(dir, "studio.gd"), STUDIO_AUTOLOAD);
  await fsp.writeFile(path.join(dir, "main.tscn"), MAIN_SCENE);
  await fsp.writeFile(path.join(dir, "export_presets.cfg"), EXPORT_PRESETS);
  for (const [name, content] of Object.entries(files)) {
    if (!SAFE_PATH.test(name) || name.includes("..") || typeof content !== "string") { problems.push(`Rejected file path ${name}.`); continue; }
    if (name.endsWith(".gd") && FORBIDDEN_GD.test(content)) { problems.push(`${name} uses a prohibited API (network, files, shell or dynamic execution).`); continue; }
    if (/^scripts\/main\.gd$/.test(name) === false && /res:\/\/(?!scripts|scenes|data|studio\.gd|main\.tscn)/.test(content)) { problems.push(`${name} references a file outside scripts/, scenes/ or data/.`); }
    await fsp.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fsp.writeFile(path.join(dir, name), content);
  }
  if (!files["scripts/main.gd"]) problems.push("scripts/main.gd is required (it must extend Node2D and start the game).");
  return problems;
}

// Imports resources, then plays the game headless for a few seconds with random input and collects script errors.
async function checkProject(godot, dir, { frames = 900 } = {}) {
  const imported = await run(godot, ["--headless", "--path", dir, "--import"], { timeoutMs: 120_000 });
  let errors = extractErrors(imported.output);
  if (errors.length) return errors;
  const played = await run(godot, ["--headless", "--path", dir, "--quit-after", String(frames), "--", "--fuzz"], { timeoutMs: 90_000 });
  errors = extractErrors(played.output);
  if (played.code !== 0 && !errors.length) errors.push(`Godot exited with code ${played.code}: ${played.output.slice(-400)}`);
  return errors;
}

async function exportWeb(godot, dir, outDir) {
  await fsp.rm(outDir, { recursive: true, force: true });
  await fsp.mkdir(outDir, { recursive: true });
  const result = await run(godot, ["--headless", "--path", dir, "--export-release", EXPORT_PRESET, path.join(outDir, "index.html")], { timeoutMs: 180_000 });
  const produced = await fsp.readdir(outDir).catch(() => []);
  if (!produced.includes("index.html") || !produced.some((name) => name.endsWith(".pck")) || !produced.some((name) => name.endsWith(".wasm"))) {
    throw new Error(`Godot Web export failed: ${result.output.slice(-600)}`);
  }
  return produced;
}

module.exports = { checkProject, exportWeb, extractErrors, findGodot, run, writeProject, SAFE_PATH };
