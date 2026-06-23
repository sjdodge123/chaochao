const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const bundles = {
    'play.bundle.min.js': [
        'client/scripts/rhill-voronoi-core.js',
        'client/scripts/barrierArt.js',
        'client/scripts/game.js',
        'client/scripts/perf.js',
        'client/scripts/metrics.js',
        'client/scripts/ads.js',
        'client/scripts/client.js',
        'client/scripts/discordVoice.js',
        'client/scripts/connectionHud.js',
        'client/scripts/audio.js',
        'client/scripts/input.js',
        'client/scripts/gamepad.js',
        'client/scripts/trailEffects.js',
        'client/scripts/draw_skins.js',
        'client/scripts/draw.js',
        'client/scripts/draw_patterns.js',
        'client/scripts/draw_hazards.js',
        'client/scripts/draw_hud.js',
        'client/scripts/borderEffects.js',
        'client/scripts/terrainfx.js',
        'client/scripts/skinRegistry.js',
        'client/scripts/celebrations.js',
        'client/scripts/gameboard.js',
        'client/scripts/haptics.js',
        'client/scripts/lobbyHub.js',
        'client/scripts/audience.js',
        'client/scripts/recap.js',
        'client/scripts/joystick.js',
        'client/scripts/utils.js',
        'client/scripts/perfharness.js'
    ],
    'create.bundle.min.js': [
        'client/scripts/rhill-voronoi-core.js',
        'client/scripts/barrierArt.js',
        'client/scripts/create.js',
        'client/scripts/editorTools.js',
        'client/scripts/osk.js',
        'client/scripts/editorGamepad.js',
        'client/scripts/utils.js',
        'client/scripts/controllerHeader.js'
    ],
    'join.bundle.min.js': [
        'client/scripts/join.js',
        'client/scripts/osk.js',
        'client/scripts/menuGamepad.js',
        'client/scripts/controllerHeader.js'
    ]
};

const outDir = 'client/scripts/dist';

// The Discord Activity presence module is the exception to the concat-globals model: it
// IMPORTS the Embedded App SDK from node_modules, so it needs a real module bundle
// (esbuild `build`, not `transform`) emitted as a self-contained IIFE. It's injected
// INTO play.html (approach b: the game frame IS the Activity entry — index.js
// discordEmbedRewrite + the <!-- DISCORD_PRESENCE --> placeholder) and inits the SDK
// once in-frame for auth + instance->room routing + participant presence. See
// docs/spikes/discord-activity.md.
const discordBundles = {
    'discord-presence.bundle.min.js': 'client/scripts/discordPresence.js'
};

async function buildAll() {
    fs.mkdirSync(outDir, { recursive: true });
    for (const [outFile, sources] of Object.entries(bundles)) {
        const code = sources.map(f => fs.readFileSync(f, 'utf8')).join('\n;\n');
        const result = await esbuild.transform(code, { minify: true, loader: 'js' });
        const target = path.join(outDir, outFile);
        fs.writeFileSync(target, result.code);
        console.log(target + ' (' + result.code.length + ' bytes)');
    }
    // Discord Activity bundles (module resolution + tree-shake of the SDK).
    for (const [outFile, entry] of Object.entries(discordBundles)) {
        if (!fs.existsSync(entry)) { continue; }
        const target = path.join(outDir, outFile);
        await esbuild.build({
            entryPoints: [entry],
            bundle: true,
            minify: true,
            format: 'iife',
            target: ['es2018'],
            outfile: target,
            logLevel: 'silent'
        });
        console.log(target + ' (' + fs.statSync(target).size + ' bytes)');
    }
}

buildAll().catch(err => {
    console.error(err);
    process.exit(1);
});
