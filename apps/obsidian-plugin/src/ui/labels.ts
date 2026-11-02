import type { WorkspaceState } from "@vault-rooms/secure";

const snapshots = new WeakMap<WorkspaceState, ReturnType<typeof buildLabels>>();

function buildLabels(state: WorkspaceState) {
  const names = new Map<string, number>();
  const devicesByUser = new Map<string, Array<[string, WorkspaceState["devices"][string]]>>();
  const deviceNames = new Map<string, number>();
  for (const user of Object.values(state.users)) if (!user.removed) names.set(user.name, (names.get(user.name) ?? 0) + 1);
  for (const [id, device] of Object.entries(state.devices)) if (!device.revoked) {
    const devices = devicesByUser.get(device.user) ?? [];
    devices.push([id, device]);
    devicesByUser.set(device.user, devices);
    const key = JSON.stringify([device.user, device.name]);
    deviceNames.set(key, (deviceNames.get(key) ?? 0) + 1);
  }
  return { names, deviceNames, devicesByUser };
}

export function membershipLabels(state: WorkspaceState): ReturnType<typeof buildLabels> {
  let labels = snapshots.get(state);
  if (!labels) { labels = buildLabels(state); snapshots.set(state, labels); }
  return labels;
}

/**
 * How people and computers are named wherever someone is picked or confirmed: names needn't be unique, so one that
 * another shares gets the start of its id, the same everywhere.
 */
export function personLabel(state: WorkspaceState, userId: string): string {
  const name = state.users[userId]?.name ?? "?";
  const twin = (membershipLabels(state).names.get(name) ?? 0) > (state.users[userId] && !state.users[userId]!.removed ? 1 : 0);
  return twin ? `${name} (${userId.slice(1, 5)})` : name;
}

/** A computer's name, told apart from another of the same person's by the start of its id, and whose it is. */
export function deviceLabel(state: WorkspaceState, deviceId: string): string {
  const device = state.devices[deviceId];
  if (!device) return "?";
  const twin = (membershipLabels(state).deviceNames.get(JSON.stringify([device.user, device.name])) ?? 0) > (device.revoked ? 0 : 1);
  return `"${twin ? `${device.name} (${deviceId.slice(1, 5)})` : device.name}" of ${personLabel(state, device.user)}`;
}
