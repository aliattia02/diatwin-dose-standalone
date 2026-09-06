// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';





// jsdom implements neither ResizeObserver nor element layout, and recharts'
// ResponsiveContainer needs both: it observes its parent and renders nothing
// until it has measured a non-zero size. Without these two shims every chart
// component throws "ResizeObserver is not defined" on mount, which is a fact
// about the test environment rather than about the code under test.
//
// The observer never fires. That is deliberate — these tests assert on the
// numbers and labels around a chart, not on the SVG geometry, and a stub that
// invented sizes would make them depend on made-up layout.
if (typeof global.ResizeObserver === 'undefined') {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// ResponsiveContainer reads these to decide whether it has room to draw.
for (const [prop, value] of [['offsetWidth', 800], ['offsetHeight', 320]]) {
  if (!Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, prop)?.get) {
    Object.defineProperty(window.HTMLElement.prototype, prop, {
      configurable: true,
      value,
    });
  }
}
