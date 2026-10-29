import { join, dirname } from "node:path";
import { roots, exists } from "./files.js";
import {
  discover,
  discoverInstallations,
  installedVersion,
  type Existing,
} from "./inventory.js";
import type { Selection, SkillState, CatalogItem } from "./model.js";
import { compareVersions } from "./version.js";
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
  async function status(entry: Existing, item: CatalogItem) {
    const version = entry.present
      ? await installedVersion(entry.path)
      : undefined;
    let updateStatus: "available" | "current" | "unknown" = "unknown";
    let updateReason: "version" | "commit" | undefined;
    const uniqueSource = entry.record
      ? entry.record.repo === item.repo
      : state.sources.filter((source) => source.metadata?.name === entry.name)
          .length === 1;
    if (
      entry.kind === "installed" &&
      item.status === "available" &&
      entry.name === item.name &&
      uniqueSource
    ) {
      if (version && item.version) {
        const compared = compareVersions(item.version, version);
        if (compared !== undefined) {
          updateStatus = compared > 0 ? "available" : "current";
          if (compared > 0) updateReason = "version";
        }
      } else if (entry.record?.commit) {
        updateStatus =
          entry.record.commit === item.commit ? "current" : "available";
        if (updateStatus === "available") updateReason = "commit";
      }
    }
    return {
      path: entry.path,
      installed: entry.present,
      ...(version ? { version } : {}),
      updateStatus,
      ...(updateReason ? { updateReason } : {}),
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
          if ("entry" in destination) return status(destination.entry, item);
          const matching = existing.find(
            (entry) =>
              dirname(entry.path) === destination.root &&
              (entry.record
                ? entry.record.repo === item.repo
                : entry.name === item.name),
          );
          if (matching) return status(matching, item);
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
