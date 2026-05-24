const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const bundles = {
    'play.bundle.min.js': [
        'client/scripts/game.js',
        'client/scripts/auth.js',
        'client/scripts/client.js',
        'client/scripts/audio.js',
        'client/scripts/input.js',
        'client/scripts/gamepad.js',
        'client/scripts/draw.js',
        'client/scripts/gameboard.js',
        'client/scripts/lobbyHub.js',
        'client/scripts/audience.js',
        'client/scripts/recap.js',
        'client/scripts/joystick.js',
        'client/scripts/utils.js'
    ],
    'create.bundle.min.js': [
        'client/scripts/rhill-voronoi-core.js',
        'client/scripts/create.js',
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

async function buildAll() {
    fs.mkdirSync(outDir, { recursive: true });
    for (const [outFile, sources] of Object.entries(bundles)) {
        const code = sources.map(f => fs.readFileSync(f, 'utf8')).join('\n;\n');
        const result = await esbuild.transform(code, { minify: true, loader: 'js' });
        const target = path.join(outDir, outFile);
        fs.writeFileSync(target, result.code);
        console.log(target + ' (' + result.code.length + ' bytes)');
    }
}

buildAll().catch(err => {
    console.error(err);
    process.exit(1);
});
