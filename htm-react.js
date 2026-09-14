// htm-react.js — binds the `htm` tagged-template library to React.createElement so
// the rest of the app can write JSX-like markup (html`<div>...</div>`) without any
// bundler or Babel transform. `htm` and `react`/`react-dom` are both loaded as
// plain <script> globals in index.html.
export const html = htm.bind(React.createElement);
