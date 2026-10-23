import { createHighlightCore } from '../src/core.js';
import { createCodePlugin } from '../src/streamdown.js';
window.__createPlugin = async () => createCodePlugin({ core: createHighlightCore({ baseUrl: '/dist/' }) });
