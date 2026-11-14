/// <reference path="./node_modules/@nativescript/types-android/lib/android-35.d.ts" />

declare module "*.blp?shared-tree" {
  import type { build } from "@gjsify/adwaita-nativescript/builder";
  const tree: Parameters<typeof build>[0];
  export default tree;
}
