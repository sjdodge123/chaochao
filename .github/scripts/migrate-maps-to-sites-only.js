// One-shot migration: convert the full-geometry originals in maps-archive/ into
// the compact sites-only format in client/maps/. Each map is reconstructed and
// re-checked before its file is replaced; any map that fails to reconstruct
// equivalently is left in full format (copied through unchanged) and reported.
//
//   node .github/scripts/migrate-maps-to-sites-only.js [--check]
//
// --check: dry run (report what would change, write nothing).

const fs = require('fs');
const path = require('path');
const mapFormat = require('../../server/mapFormat.js');

const checkOnly = process.argv.includes('--check');
const archiveDir = path.join(__dirname, '../../maps-archive');
const mapsDir = path.join(__dirname, '../../client/maps');

const EPS = 1e-6;
function ringPoints(cell) {
    const pts = [];
    for (const he of cell.halfedges) {
        const e = he.edge;
        const sameLeft = e.lSite && he.site && e.lSite.x === he.site.x && e.lSite.y === he.site.y && e.lSite.voronoiId === he.site.voronoiId;
        const sp = sameLeft ? e.va : e.vb;
        if (sp) { pts.push(sp); }
    }
    return pts;
}
function equivalent(orig, reb) {
    if (orig.cells.length !== reb.cells.length) { return false; }
    const rV = {}; for (const c of reb.cells) { rV[c.site.voronoiId] = c; }
    for (const oc of orig.cells) {
        const rc = rV[oc.site.voronoiId];
        if (!rc || oc.id !== rc.id || oc.site.x !== rc.site.x || oc.site.y !== rc.site.y) { return false; }
        const op = ringPoints(oc), rp = ringPoints(rc);
        if (op.length !== rp.length) { return false; }
        for (const a of op) {
            if (!rp.some((b) => Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS)) { return false; }
        }
    }
    return true;
}

const files = fs.readdirSync(archiveDir).filter((f) => f.endsWith('.json'));
let converted = 0, kept = 0, sizeBefore = 0, sizeAfter = 0;
for (const f of files) {
    const orig = JSON.parse(fs.readFileSync(path.join(archiveDir, f), 'utf8'));
    const beforeBytes = fs.statSync(path.join(archiveDir, f)).size;
    sizeBefore += beforeBytes;
    if (!Array.isArray(orig.cells)) { console.log(`keep   ${f} (not full-geometry)`); kept++; continue; }

    let sitesOnly, ok = false;
    try {
        sitesOnly = mapFormat.toSitesOnly(orig);
        ok = equivalent(orig, mapFormat.reconstruct(sitesOnly));
    } catch (e) {
        console.log(`KEEP   ${f} (reconstruct threw: ${e.message}) — left in full format`);
    }
    if (!ok) {
        if (sitesOnly === undefined) { kept++; sizeAfter += beforeBytes; continue; }
        console.log(`KEEP   ${f} (not equivalent) — left in full format`);
        kept++; sizeAfter += beforeBytes; continue;
    }
    const out = JSON.stringify(sitesOnly, null, 2);
    sizeAfter += Buffer.byteLength(out);
    if (!checkOnly) { fs.writeFileSync(path.join(mapsDir, f), out); }
    console.log(`${checkOnly ? 'would-convert' : 'convert'} ${f}  ${(beforeBytes / 1024).toFixed(0)}KB -> ${(Buffer.byteLength(out) / 1024).toFixed(1)}KB`);
    converted++;
}
console.log(`\n${converted} converted, ${kept} kept full.  Total ${(sizeBefore / 1048576).toFixed(1)} MB -> ${(sizeAfter / 1048576).toFixed(2)} MB (${((1 - sizeAfter / sizeBefore) * 100).toFixed(1)}% smaller)${checkOnly ? '  [dry run]' : ''}`);
