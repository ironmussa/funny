/** Markdown export, screenshots and sending annotations to Funny. */

import { actions } from './actions';
import { safeSendMessage, showToast } from './dom';
import { clearDrawing, getDrawingDataUrl, toggleDrawMode } from './drawing';
import { saveToHistory } from './history';
import { clearMultiSelect, renderAnnotations } from './overlays';
import { st } from './state';

// ---------------------------------------------------------------------------
// Generate markdown output
// ---------------------------------------------------------------------------
export function generateMarkdown(): string {
  if (st.annotations.length === 0) return '';

  // -- User instructions first (clear, top-level) --
  const instructions = st.annotations
    .map((ann, i) =>
      ann.prompt ? `${st.annotations.length > 1 ? `${i + 1}. ` : ''}${ann.prompt}` : null,
    )
    .filter(Boolean);

  let md = '';
  if (instructions.length > 0) {
    md += instructions.join('\n') + '\n\n';
  }

  // -- UI context as supporting reference --
  md += `<details>\n<summary>UI Context: ${window.location.href}</summary>\n\n`;
  md += `**Page title:** ${document.title}\n`;
  md += `**Viewport:** ${window.innerWidth}x${window.innerHeight}\n`;
  md += `**Date:** ${new Date().toISOString()}\n\n`;

  st.annotations.forEach((ann, i) => {
    md += `### Annotated element ${i + 1}`;
    if (ann.elements.length > 1) md += ` (${ann.elements.length} elements)`;
    md += `\n\n`;

    ann.elements.forEach((elem, j) => {
      if (ann.elements.length > 1) md += `#### Element ${j + 1}: \`${elem.elementName}\`\n\n`;
      md += `**Element:** \`${elem.element}\` at \`${elem.elementPath}\`\n`;
      md += `**Position:** ${elem.x}% from left, ${elem.y}px from top\n`;
      if (elem.cssClasses) md += `**Classes:** \`${elem.cssClasses}\`\n`;
      if (elem.componentTree) md += `**Component Tree:** \`${elem.componentTree}\`\n`;
      md += `**Styles:** ${elem.computedStyles}\n`;
      md += `**Accessibility:** ${elem.accessibility}\n`;
      md += `**Nearby text:** ${elem.nearbyText}\n`;
      md += `**Bounding box:** ${elem.boundingBox.width}x${elem.boundingBox.height} at (${elem.boundingBox.x}, ${elem.boundingBox.y})\n`;
      if (elem.isFixed) md += `**Fixed position:** yes\n`;
      md += `\n**HTML (truncated):**\n\`\`\`html\n${elem.outerHTML.slice(0, 500)}\n\`\`\`\n\n`;
    });

    if (i < st.annotations.length - 1) md += `---\n\n`;
  });

  md += `</details>`;

  return md;
}

export function copyAsMarkdown() {
  const md = generateMarkdown();
  if (!md) return;
  navigator.clipboard.writeText(md).then(() => {
    showToast('Copied to clipboard');
  });
}

// ---------------------------------------------------------------------------
// Merge drawing overlay with screenshot
// ---------------------------------------------------------------------------
function mergeDrawingWithScreenshot(
  screenshotDataUrl: string,
  drawingDataUrl: string,
): Promise<string> {
  return new Promise((resolve) => {
    const screenshotImg = new Image();
    screenshotImg.onload = () => {
      const drawingImg = new Image();
      drawingImg.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = screenshotImg.width;
        canvas.height = screenshotImg.height;
        const ctx = canvas.getContext('2d')!;
        // Draw screenshot as base
        ctx.drawImage(screenshotImg, 0, 0);
        // Draw the red pen overlay on top (scale drawing to match screenshot dimensions)
        ctx.drawImage(drawingImg, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      };
      drawingImg.src = drawingDataUrl;
    };
    screenshotImg.src = screenshotDataUrl;
  });
}

// ---------------------------------------------------------------------------
// Send to Funny
// ---------------------------------------------------------------------------
export async function sendToFunny() {
  if (st.annotations.length === 0 && !st.hasDrawingContent) {
    showToast('No annotations or drawings to send');
    return;
  }

  const sendBtn = st.toolbarEl.querySelector<HTMLButtonElement>('[data-action="send"]')!;
  sendBtn.classList.add('toolbar-btn-loading');
  sendBtn.setAttribute('disabled', 'true');

  try {
    // Exit draw mode if active so canvas is hidden before screenshot
    const wasDrawing = st.isDrawing;
    const drawingData = getDrawingDataUrl();
    if (wasDrawing) toggleDrawMode();

    // Take screenshot
    let screenshot = await captureScreenshot();

    // Merge drawing overlay onto screenshot
    if (screenshot && drawingData) {
      screenshot = await mergeDrawingWithScreenshot(screenshot, drawingData);
    } else if (!screenshot && drawingData) {
      // No screenshot available — use drawing as the image
      screenshot = drawingData;
    }

    // Serialize annotations (strip domElement refs from each element)
    const serialized = st.annotations.map((ann) => ({
      ...ann,
      elements: ann.elements.map(({ domElement: _domElement, ...rest }) => rest),
    }));

    let markdown = generateMarkdown();

    // Include draw prompt if provided
    const drawPrompt = st.drawPromptInput?.value?.trim() || '';
    if (drawPrompt) {
      markdown = markdown ? `${drawPrompt}\n\n${markdown}` : drawPrompt;
    }
    if (st.hasDrawingContent && !drawPrompt && !markdown) {
      markdown = 'See the annotated screenshot — the red drawings highlight the areas of interest.';
    }

    // Send to background worker
    safeSendMessage(
      {
        type: 'SEND_TO_FUNNY',
        data: {
          url: window.location.href,
          title: document.title,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          annotations: serialized,
          markdown,
          screenshot,
        },
      },
      (response: any) => {
        sendBtn.classList.remove('toolbar-btn-loading');
        sendBtn.removeAttribute('disabled');

        if (response?.success) {
          // Save to history before clearing
          saveToHistory(serialized, response.threadId, response.projectId);

          // Clear all annotations and drawings
          st.annotations = [];
          clearMultiSelect();
          clearDrawing();
          if (st.drawPromptInput) st.drawPromptInput.value = '';
          renderAnnotations();
          actions().updateToolbarCount();

          showToast('Sent to Funny! Thread created.');
        } else {
          showToast(response?.error || 'Failed to send. Is Funny running?', true);
        }
      },
    );
  } catch (err: any) {
    sendBtn.classList.remove('toolbar-btn-loading');
    sendBtn.removeAttribute('disabled');
    showToast(`Error: ${err.message}`, true);
  }
}

function captureScreenshot(): Promise<string | null> {
  return new Promise((resolve) => {
    safeSendMessage({ type: 'CAPTURE_SCREENSHOT' }, (response: any) => {
      resolve(response?.screenshot || null);
    });
  });
}

// ---------------------------------------------------------------------------
// Copy screenshot to clipboard
// ---------------------------------------------------------------------------
export async function copyScreenshotToClipboard() {
  try {
    // Get drawing overlay if any
    const drawingData = getDrawingDataUrl();

    // Hide toolbars temporarily for a clean screenshot
    const drawToolbarDisplay = st.drawToolbar.style.display;
    const toolbarDisplay = st.toolbarEl.style.display;
    st.drawToolbar.style.display = 'none';
    st.toolbarEl.style.display = 'none';

    let screenshot = await captureScreenshot();

    // Restore toolbars
    st.drawToolbar.style.display = drawToolbarDisplay;
    st.toolbarEl.style.display = toolbarDisplay;

    // Merge drawing overlay onto screenshot if there are drawings
    if (screenshot && drawingData) {
      screenshot = await mergeDrawingWithScreenshot(screenshot, drawingData);
    } else if (!screenshot && drawingData) {
      screenshot = drawingData;
    }

    if (!screenshot) {
      showToast('Failed to capture screenshot', true);
      return;
    }

    // Convert data URL to blob and copy to clipboard
    const response = await fetch(screenshot);
    const blob = await response.blob();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);

    showToast('Screenshot copied to clipboard!');
  } catch (err: any) {
    showToast(`Failed to copy: ${err.message}`, true);
  }
}
