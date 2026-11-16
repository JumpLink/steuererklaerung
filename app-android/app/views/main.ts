import type { EventData, Page } from "@nativescript/core";
import { BhMainWindow } from "../window.ts";

export function onLoaded(args: EventData): void {
  (args.object as Page).content = new BhMainWindow();
  console.log("STEUER window built");
}
