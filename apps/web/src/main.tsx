/**
 * Browser harness entry point.
 *
 * Deliberately thin: it mounts the shared `@adnota/view` app and nothing else, so the
 * harness and the desktop window cannot drift apart in behaviour. If something needs
 * to differ between them, it belongs in a prop here rather than in a fork of the UI.
 */

import { mountApp } from '@adnota/view';
import '@adnota/view/styles.css';

const container = document.getElementById('app');
if (!container) throw new Error('Missing #app root element');

mountApp(container);