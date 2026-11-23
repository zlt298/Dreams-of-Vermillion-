// The Lancer combat engine. Deterministic given a seed; UI-free.
// The implementation lives in ./battle/: core.ts holds the Battle class (state and typed method stubs);
// each area module (turns, damage, movement, attacks, actions, terrain, tech, fields, decisions) holds the logic.
export * from './battle/core'
