// In-memory round-robin state is shared by management routes and the request path.
// Keep it dependency-free so CRUD routes do not load the full combo execution engine.
const comboRotationState = new Map();

export function getComboRotationState(comboName) {
  return comboRotationState.get(comboName);
}

export function setComboRotationState(comboName, state) {
  comboRotationState.set(comboName, state);
}

export function resetComboRotation(comboName) {
  if (comboName) comboRotationState.delete(comboName);
  else comboRotationState.clear();
}
