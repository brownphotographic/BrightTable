/*
 * BrightTable // Copyright (C) 2026 Rob Brown
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

// Builds a navigable tree out of the flat list of real folder paths returned
// by getFolderPaths() (Immich's GET /view/folder/unique-paths) - one entry
// per directory that directly contains at least one asset. Mirrors the
// approach Immich's own web app uses for its Folders view (see
// web/src/lib/utils/tree-utils.ts), adapted to this app's data shapes.

export interface FolderNode {
  // Display label - may be several path segments joined together (see
  // collapse() below), e.g. "libraries" collapsing what was really
  // "upload/library/admin".
  name: string;
  // Full path from the root, as it should be passed to getFolderAssets().
  path: string;
  // True if this exact path was itself one of the input paths (i.e. it
  // directly contains assets, not just subfolders).
  hasAssets: boolean;
  children: FolderNode[];
}

interface MutableNode {
  name: string;
  path: string;
  hasAssets: boolean;
  children: Map<string, MutableNode>;
}

function joinPath(base: string, segment: string): string {
  return base ? `${base}/${segment}` : segment;
}

export function buildFolderTree(paths: string[]): FolderNode {
  const root: MutableNode = { name: '', path: '', hasAssets: false, children: new Map() };
  for (const p of paths) {
    let cur = root;
    let curPath = '';
    for (const segment of p.split('/').filter((s) => s.length > 0)) {
      curPath = joinPath(curPath, segment);
      let next = cur.children.get(segment);
      if (!next) {
        next = { name: segment, path: curPath, hasAssets: false, children: new Map() };
        cur.children.set(segment, next);
      }
      cur = next;
    }
    cur.hasAssets = true;
  }
  collapseSingleChildDirs(root);
  return freeze(root);
}

// Folds a chain of asset-less directories that each have exactly one
// subfolder into a single display node, e.g. a library mounted at one root
// shows as one "libraries" row instead of an empty nesting doll around the
// years underneath it - same behavior as Immich's own Folders view.
// Depth-first (children first) so a whole multi-level chain collapses in one
// pass: by the time a node checks itself, its only child already reflects
// its own fully-collapsed subtree.
function collapseSingleChildDirs(node: MutableNode) {
  for (const child of node.children.values()) collapseSingleChildDirs(child);
  if (node.children.size === 1 && !node.hasAssets) {
    const [only] = [...node.children.values()];
    node.name = node.name ? `${node.name}/${only.name}` : only.name;
    node.path = only.path;
    node.hasAssets = only.hasAssets;
    node.children = only.children;
  }
}

function freeze(node: MutableNode): FolderNode {
  return {
    name: node.name,
    path: node.path,
    hasAssets: node.hasAssets,
    children: [...node.children.values()]
      .map(freeze)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
  };
}

export function findFolderNode(node: FolderNode, path: string): FolderNode | null {
  if (node.path === path) return node;
  for (const child of node.children) {
    const found = findFolderNode(child, path);
    if (found) return found;
  }
  return null;
}

// Every path under `node` (including itself) that directly holds assets -
// this is what feeds the grid's list of fetchable sections, whether the
// selected tree node is a single leaf folder or a whole subtree.
export function collectAssetPaths(node: FolderNode): string[] {
  const out: string[] = [];
  if (node.hasAssets) out.push(node.path);
  for (const child of node.children) out.push(...collectAssetPaths(child));
  return out;
}
