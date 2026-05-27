# maps-archive

Frozen copies of the original full-geometry map JSON (raw rhill-voronoi diagram:
`cells`/`edges`/`vertices` + embedded `thumbnail`), kept as the migration source
of truth and a fallback while `client/maps/` moves to the compact **sites-only**
format (`{ bbox, sites:[{x,y,id}], hazards, startEdges, parTime, name, author, id }`).

These files are NOT loaded at runtime (they live outside `client/maps/`, so the
server's `loadMaps()` never sees them, and nothing under here ships to the browser).
The live maps in `client/maps/` are regenerated from these via the migration script
and verified byte-for-byte equivalent (cell adjacency + voronoiId mapping + clipped
polygon geometry) by `.github/scripts/` reconstruction test.

Safe to delete in a later commit once the sites-only format is proven in production
— git history retains every original blob regardless.
