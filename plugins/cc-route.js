/**
 * Entry for the CLI-backed model route. The route has its own folder (its own licence notice, and the one place in
 * the bundle that may name its vendor); this file only lets the bundle patch refer to it.
 */
export { name, inject, apply } from "../claude-code/plugin.js";
