"use strict";
// Shared 2D segment geometry. A leaf module (requires nothing) so both the engine
// (player collision: stone seams + barriers) and cellGraph (bot pathing: barrier
// edge cuts) share ONE implementation instead of each keeping a private copy.

function sideOf(ax, ay, bx, by, px, py) {
    return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}
// Whether segments p0->p1 and p2->p3 properly intersect (standard cross-product test).
function segmentsCross(p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y) {
    var d1 = sideOf(p2x, p2y, p3x, p3y, p0x, p0y);
    var d2 = sideOf(p2x, p2y, p3x, p3y, p1x, p1y);
    var d3 = sideOf(p0x, p0y, p1x, p1y, p2x, p2y);
    var d4 = sideOf(p0x, p0y, p1x, p1y, p3x, p3y);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

exports.sideOf = sideOf;
exports.segmentsCross = segmentsCross;
