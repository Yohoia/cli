import { join, dirname } from "node:path";
import { roots, exists } from "./files.js";
import {
  discover,
  discoverInstallations,
  installedVersion,
  type Existing,
} from "./inventory.js";
import type { Selection, SkillState, CatalogItem } from "./model.js";
export async function installedStatus(
  items: CatalogItem[],
  selection: Selection,
  state: SkillState,
  automatic = false,
): Promise<CatalogItem[]> {
  const destinations = await roots(selection);
  const existing = automatic
    ? await discoverInstallations(state, { kind: "automatic", all: false })
    : await discover(state, selection);
  async function status(entry: Existing) {
    const version = entry.present
      ? await installedVersion(entry.path)
      : undefined;
    return {
      path: entry.path,
      installed: entry.present,
      ...(version ? { version } : {}),
      ...(entry.problem ? { message: entry.problem } : {}),
    };
  }
  return Promise.all(
    items.map(async (item) => ({
      ...item,
      targets: await Promise.all(
        (automatic
          ? existing
              .filter((entry) =>
                entry.record
                  ? entry.record.repo === item.repo
                  : entry.name === item.name,
              )
              .map((entry) => ({ entry }))
          : destinations.map((root) => ({ root }))
        ).map(async (destination) => {
          if ("entry" in destination) return status(destination.entry);
          const matching = existing.find(
            (entry) =>
              dirname(entry.path) === destination.root &&
              (entry.record
                ? entry.record.repo === item.repo
                : entry.name === item.name),
          );
          if (matching) return status(matching);
          const sameName = existing.find(
            (entry) =>
              dirname(entry.path) === destination.root &&
              entry.name === item.name &&
              !entry.problem,
          );
          const path =
            sameName?.path ?? join(destination.root, item.name ?? "invalid");
          const occupied = await exists(path);
          return {
            path,
            installed: false,
            ...(occupied
              ? {
                  occupied: true,
                  message: "同名目标目录已存在，归属于其他来源或内容",
                }
              : {}),
          };
        }),
      ),
    })),
  );
}
