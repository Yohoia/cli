import type { RemoteArticle } from "../../remote/model.js";
import type { CatalogItem } from "../../skills/model.js";

export type Page = "blog" | "skill" | "sources";
export type Row = {
  id: string;
  name: string;
  detail: string;
  search: string;
  date: string;
  status: string;
  version: string;
  article?: RemoteArticle;
  skill?: CatalogItem;
};
export type ListState = {
  rows: Row[];
  selected: Set<string>;
  cursor: number;
  search: string;
  sort: "date" | "name" | "status";
  ascending: boolean;
  notice: string;
};
export function listState(page: Page): ListState {
  return {
    rows: [],
    selected: new Set(),
    cursor: 0,
    search: "",
    sort: page === "blog" ? "date" : "name",
    ascending: page !== "blog",
    notice: "",
  };
}
export function visibleRows(state: ListState): Row[] {
  const query = state.search.toLocaleLowerCase();
  return state.rows
    .filter((row) => row.search.toLocaleLowerCase().includes(query))
    .sort((left, right) => {
      const a = left[state.sort];
      const b = right[state.sort];
      const compared = a.localeCompare(b) || left.id.localeCompare(right.id);
      return state.ascending ? compared : -compared;
    });
}
