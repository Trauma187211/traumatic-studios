// Free, text-based study material, grouped into tracks the studio can be put through. Every address was checked to be reachable.
const wiki = (name) => `https://en.wikipedia.org/wiki/${name}`;
const patterns = (name) => `https://gameprogrammingpatterns.com/${name}.html`;
const godot = (route) => `https://docs.godotengine.org/en/stable/${route}.html`;
const mdn = (route) => `https://developer.mozilla.org/en-US/docs/Games/${route}`;
const redblob = (route) => `https://www.redblobgames.com/${route}`;

const TRACKS = [
  {
    id: "design",
    title: "Game design and game feel",
    urls: [wiki("Game_design"), wiki("Game_mechanics"), wiki("Game_feel"), wiki("Game_balance"), wiki("Difficulty_level"), wiki("Level_design"), wiki("Flow_(psychology)"), wiki("Skill_tree"), "https://www.gamedeveloper.com/design/the-art-of-screenshake"],
  },
  {
    id: "genres",
    title: "Genre playbooks (platformer, RPG, roguelike, puzzle, strategy, tower defense and more)",
    urls: [wiki("Platform_game"), wiki("Action-adventure_game"), wiki("Role-playing_video_game"), wiki("Roguelike"), wiki("Metroidvania"), wiki("Puzzle_video_game"), wiki("Real-time_strategy"), wiki("Tower_defense")],
  },
  {
    id: "code",
    title: "Game programming patterns",
    urls: ["game-loop", "update-method", "state", "component", "command", "observer", "event-queue", "object-pool", "flyweight", "double-buffer", "spatial-partition"].map(patterns),
  },
  {
    id: "algorithms",
    title: "Game algorithms (pathfinding, procedural generation, AI, grids)",
    urls: [redblob("pathfinding/a-star/introduction.html"), redblob("pathfinding/a-star/implementation.html"), redblob("grids/hexagons/"), redblob("maps/terrain-from-noise/"), redblob("articles/visibility/"), wiki("Procedural_generation"), wiki("Perlin_noise"), wiki("Wave_function_collapse"), wiki("Cellular_automaton"), wiki("Game_AI"), wiki("Behavior_tree_(artificial_intelligence)"), wiki("Finite-state_machine"), wiki("Quadtree")],
  },
  {
    id: "web",
    title: "Browser game craft (canvas, collision, tilemaps, audio, touch)",
    urls: [mdn("Anatomy"), mdn("Techniques/2D_collision_detection"), mdn("Techniques/Tilemaps"), mdn("Techniques/Efficient_animation_for_web_games"), mdn("Techniques/Crisp_pixel_art_look"), mdn("Techniques/Audio_for_Web_Games"), mdn("Techniques/Control_mechanisms/Mobile_touch"), mdn("Tutorials/2D_Breakout_game_pure_JavaScript"), "https://phaser.io/tutorials/making-your-first-phaser-3-game"],
  },
  {
    id: "godot",
    title: "Godot 4 engine documentation",
    urls: [
      "getting_started/introduction/key_concepts_overview", "tutorials/scripting/gdscript/gdscript_basics", "getting_started/step_by_step/signals", "tutorials/best_practices/scene_organization",
      "tutorials/2d/2d_movement", "tutorials/physics/using_character_body_2d", "tutorials/2d/using_tilemaps", "tutorials/2d/2d_sprite_animation", "tutorials/2d/particle_systems_2d",
      "tutorials/inputs/input_examples", "tutorials/audio/audio_streams", "tutorials/navigation/navigation_using_navigationagents", "tutorials/animation/introduction",
    ].map(godot),
  },
];

const publicTracks = () => TRACKS.map(({ id, title, urls }) => ({ id, title, pages: urls.length }));
const trackUrls = (ids) => {
  const wanted = Array.isArray(ids) && ids.length ? new Set(ids) : null;
  return [...new Set(TRACKS.filter((track) => !wanted || wanted.has(track.id)).flatMap((track) => track.urls))];
};

module.exports = { publicTracks, trackUrls };
