// A busy machine (a build or antivirus scan running beside the tests) can make a render take longer than the 1 s default wait.
import { configure } from "@testing-library/dom";
configure({ asyncUtilTimeout: 5000 });
// Radix switches measure themselves with ResizeObserver, which jsdom lacks.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
