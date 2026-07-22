figma.showUI(__html__, {
    width: 500,
    height: 620,
    themeColors: true,
    title: 'HTML to Figma - Import Web Pages and Code',
});
const loadedFonts = new Set();
let fontIndexPromise = null;
const batches = new Map();
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
function toFigmaColor(color) {
    return {
        r: clamp(color.r / 255, 0, 1),
        g: clamp(color.g / 255, 0, 1),
        b: clamp(color.b / 255, 0, 1),
    };
}
function rgbaToPaint(color) {
    return {
        type: 'SOLID',
        color: toFigmaColor(color),
        opacity: clamp(color.a, 0, 1),
    };
}
function safeDimension(value) {
    return clamp(Number.isFinite(value) ? value : 1, 0.01, 100000);
}
function styleWeight(style) {
    const s = style.toLowerCase().replace(/[-_]/g, ' ');
    if (s.includes('thin'))
        return 100;
    if (s.includes('extra light') || s.includes('ultra light'))
        return 200;
    if (s.includes('light'))
        return 300;
    if (s.includes('medium'))
        return 500;
    if (s.includes('semi bold') || s.includes('semibold') || s.includes('demi bold'))
        return 600;
    if (s.includes('extra bold') || s.includes('ultra bold'))
        return 800;
    if (s.includes('black') || s.includes('heavy'))
        return 900;
    if (s.includes('bold'))
        return 700;
    return 400;
}
async function getFontIndex() {
    if (!fontIndexPromise) {
        fontIndexPromise = figma.listAvailableFontsAsync().then((fonts) => {
            var _a;
            const index = new Map();
            for (const item of fonts) {
                const key = item.fontName.family.toLowerCase();
                const records = (_a = index.get(key)) !== null && _a !== void 0 ? _a : [];
                records.push({
                    fontName: item.fontName,
                    weight: styleWeight(item.fontName.style),
                    italic: item.fontName.style.toLowerCase().includes('italic'),
                });
                index.set(key, records);
            }
            return index;
        });
    }
    return fontIndexPromise;
}
function cleanFontFamily(value) {
    return value
        .split(',')
        .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
}
async function chooseFont(requestedFamily, requestedWeight, italic) {
    const index = await getFontIndex();
    const requested = cleanFontFamily(requestedFamily);
    const requestedPrimary = requested[0] || 'Inter';
    const genericFallbacks = {
        'sans-serif': ['Inter', 'Arial', 'Roboto'],
        serif: ['Times New Roman', 'Georgia'],
        monospace: ['Roboto Mono', 'Courier New'],
        cursive: ['Comic Sans MS'],
        fantasy: ['Impact'],
        system: ['Inter', 'Arial'],
        '-apple-system': ['Inter', 'Arial'],
        'system-ui': ['Inter', 'Arial'],
    };
    const expanded = [];
    for (const family of requested) {
        const generic = genericFallbacks[family.toLowerCase()];
        if (generic)
            expanded.push(...generic.map((item) => ({ family: item, requested: false })));
        else
            expanded.push({ family, requested: true });
    }
    expanded.push({ family: 'Inter', requested: false }, { family: 'Arial', requested: false }, { family: 'Roboto', requested: false });
    let records;
    let matchedRequestedFamily = false;
    for (const candidate of expanded) {
        records = index.get(candidate.family.toLowerCase());
        if (records === null || records === void 0 ? void 0 : records.length) {
            matchedRequestedFamily = candidate.requested;
            break;
        }
    }
    if (!(records === null || records === void 0 ? void 0 : records.length)) {
        return {
            fontName: { family: 'Inter', style: 'Regular' },
            matchedRequestedFamily: false,
            requestedPrimary,
        };
    }
    const sorted = [...records].sort((a, b) => {
        const italicPenaltyA = a.italic === italic ? 0 : 300;
        const italicPenaltyB = b.italic === italic ? 0 : 300;
        return Math.abs(a.weight - requestedWeight) + italicPenaltyA -
            (Math.abs(b.weight - requestedWeight) + italicPenaltyB);
    });
    return { fontName: sorted[0].fontName, matchedRequestedFamily, requestedPrimary };
}
async function ensureFontLoaded(fontName) {
    const key = `${fontName.family}__${fontName.style}`;
    if (loadedFonts.has(key))
        return;
    await figma.loadFontAsync(fontName);
    loadedFonts.add(key);
}
function applyCornerRadii(node, radius) {
    if (!radius)
        return;
    const [tl, tr, br, bl] = radius.map((value) => clamp(value || 0, 0, 10000));
    node.topLeftRadius = tl;
    node.topRightRadius = tr;
    node.bottomRightRadius = br;
    node.bottomLeftRadius = bl;
}
function asBytes(value) {
    return value instanceof Uint8Array ? value : new Uint8Array(value);
}
function applyShadow(node, shadow) {
    if (!shadow || shadow.color.a <= 0)
        return;
    const effect = {
        type: 'DROP_SHADOW',
        color: {
            r: clamp(shadow.color.r / 255, 0, 1),
            g: clamp(shadow.color.g / 255, 0, 1),
            b: clamp(shadow.color.b / 255, 0, 1),
            a: clamp(shadow.color.a, 0, 1),
        },
        offset: { x: shadow.offsetX || 0, y: shadow.offsetY || 0 },
        radius: Math.max(0, shadow.blur || 0),
        spread: shadow.spread || 0,
        visible: true,
        blendMode: 'NORMAL',
        showShadowBehindNode: true,
    };
    node.effects = [effect];
}
function gradientTransformFromCssAngle(angle) {
    const radians = ((angle - 90) * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return [
        [cos, sin, 0.5 - 0.5 * cos - 0.5 * sin],
        [-sin, cos, 0.5 + 0.5 * sin - 0.5 * cos],
    ];
}
function gradientToPaint(gradient) {
    const stops = gradient.stops.map((stop) => ({
        position: clamp(stop.position, 0, 1),
        color: {
            r: clamp(stop.color.r / 255, 0, 1),
            g: clamp(stop.color.g / 255, 0, 1),
            b: clamp(stop.color.b / 255, 0, 1),
            a: clamp(stop.color.a, 0, 1),
        },
    }));
    if (gradient.type === 'radial-gradient') {
        return {
            type: 'GRADIENT_RADIAL',
            gradientStops: stops,
            gradientTransform: [[1, 0, 0], [0, 1, 0]],
        };
    }
    return {
        type: 'GRADIENT_LINEAR',
        gradientStops: stops,
        gradientTransform: gradientTransformFromCssAngle(gradient.angle),
    };
}
function setMetadata(node, metadata) {
    var _a;
    if (!metadata)
        return;
    if (metadata.tag)
        node.setPluginData('htmlTag', metadata.tag);
    if (metadata.id)
        node.setPluginData('htmlId', metadata.id);
    if ((_a = metadata.classes) === null || _a === void 0 ? void 0 : _a.length)
        node.setPluginData('htmlClasses', metadata.classes.join(' '));
    if (metadata.role)
        node.setPluginData('htmlRole', metadata.role);
    if (metadata.source)
        node.setPluginData('htmlSource', metadata.source);
}
function compactLayerName(value, fallback) {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (!normalized)
        return fallback;
    return normalized.length > 100 ? `${normalized.slice(0, 97)}…` : normalized;
}
async function makeFrame(spec, parent, parentAbsX, parentAbsY, progress) {
    var _a, _b, _c, _d, _e, _f, _g;
    const frame = figma.createFrame();
    parent.appendChild(frame);
    frame.name = compactLayerName(spec.name, 'Container');
    frame.x = spec.x - parentAbsX;
    frame.y = spec.y - parentAbsY;
    frame.resize(safeDimension(spec.width), safeDimension(spec.height));
    frame.layoutMode = 'NONE';
    frame.clipsContent = Boolean(spec.clipsContent);
    frame.opacity = clamp((_a = spec.opacity) !== null && _a !== void 0 ? _a : 1, 0, 1);
    setMetadata(frame, spec.metadata);
    const fills = [];
    if (spec.backgroundImageBytes) {
        try {
            const image = figma.createImage(asBytes(spec.backgroundImageBytes));
            fills.push({ type: 'IMAGE', imageHash: image.hash, scaleMode: (_b = spec.backgroundImageFit) !== null && _b !== void 0 ? _b : 'FILL' });
        }
        catch (_error) {
            progress.warnings.add('Some CSS background images could not be created.');
        }
    }
    if ((_d = (_c = spec.gradient) === null || _c === void 0 ? void 0 : _c.stops) === null || _d === void 0 ? void 0 : _d.length)
        fills.push(gradientToPaint(spec.gradient));
    if (spec.background && spec.background.a > 0)
        fills.push(rgbaToPaint(spec.background));
    frame.fills = fills;
    if (spec.borderColor && ((_e = spec.borderWidth) !== null && _e !== void 0 ? _e : 0) > 0) {
        frame.strokes = [rgbaToPaint(spec.borderColor)];
        frame.strokeWeight = Math.max(0, (_f = spec.borderWidth) !== null && _f !== void 0 ? _f : 0);
        frame.strokeAlign = 'INSIDE';
    }
    else {
        frame.strokes = [];
    }
    applyCornerRadii(frame, spec.radius);
    applyShadow(frame, spec.shadow);
    for (const child of (_g = spec.children) !== null && _g !== void 0 ? _g : [])
        await createNode(child, frame, spec.x, spec.y, progress);
    return frame;
}
async function makeText(spec, parent, parentAbsX, parentAbsY, progress) {
    var _a, _b;
    const text = figma.createText();
    parent.appendChild(text);
    text.x = spec.x - parentAbsX;
    text.y = spec.y - parentAbsY;
    text.opacity = clamp((_a = spec.opacity) !== null && _a !== void 0 ? _a : 1, 0, 1);
    setMetadata(text, spec.metadata);
    const choice = await chooseFont(spec.fontFamily, spec.fontWeight, spec.italic);
    try {
        await ensureFontLoaded(choice.fontName);
        text.fontName = choice.fontName;
    }
    catch (_error) {
        const fallback = { family: 'Inter', style: 'Regular' };
        await ensureFontLoaded(fallback);
        text.fontName = fallback;
        progress.warnings.add(`Font “${choice.requestedPrimary}” was replaced with Inter.`);
    }
    if (!choice.matchedRequestedFamily && choice.requestedPrimary && !/^(sans-serif|serif|monospace|system-ui|-apple-system)$/i.test(choice.requestedPrimary)) {
        progress.warnings.add(`Font “${choice.requestedPrimary}” is unavailable in Figma and was replaced.`);
    }
    text.fontSize = clamp(spec.fontSize || 16, 1, 1000);
    text.fills = [rgbaToPaint(spec.color)];
    text.textAlignHorizontal = spec.align;
    text.textDecoration = spec.decoration;
    text.letterSpacing = { value: spec.letterSpacing || 0, unit: 'PIXELS' };
    text.lineHeight = {
        value: clamp(spec.lineHeight || (spec.fontSize || 16) * 1.2, 1, 10000),
        unit: 'PIXELS',
    };
    text.autoRename = true;
    text.characters = spec.text;
    if (spec.originalText && spec.originalText !== spec.text)
        text.setPluginData('htmlOriginalText', spec.originalText);
    if (spec.resizeMode === 'AUTO_WIDTH') {
        text.textAutoResize = 'WIDTH_AND_HEIGHT';
        // Browser and Figma font metrics are not identical. Keep the browser's
        // visual line breaks and gently fit the editable text into the measured
        // browser width instead of allowing Figma to wrap it in new places.
        const targetWidth = safeDimension(Math.max(1, spec.width));
        if (spec.lockedLines && text.width > targetWidth * 1.015) {
            const lines = spec.text.split('\n');
            const longestLine = lines.reduce((max, line) => Math.max(max, Array.from(line).length), 1);
            const excess = text.width - targetWidth;
            const spacingCorrection = clamp(-excess / Math.max(1, longestLine - 1), -1.5, 0);
            if (spacingCorrection < -0.01) {
                text.letterSpacing = { value: (spec.letterSpacing || 0) + spacingCorrection, unit: 'PIXELS' };
            }
            if (text.width > targetWidth * 1.04) {
                const ratio = clamp(targetWidth / text.width, 0.92, 1);
                text.fontSize = clamp((spec.fontSize || 16) * ratio, 1, 1000);
                text.lineHeight = {
                    value: clamp((spec.lineHeight || (spec.fontSize || 16) * 1.2) * ratio, 1, 10000),
                    unit: 'PIXELS',
                };
            }
        }
        const targetX = spec.x - parentAbsX;
        const targetY = spec.y - parentAbsY;
        if (spec.align === 'CENTER')
            text.x = targetX + (spec.width - text.width) / 2;
        else if (spec.align === 'RIGHT')
            text.x = targetX + spec.width - text.width;
        else
            text.x = targetX;
        // Center a one-line Figma text box inside the browser's measured line box.
        // This removes the common 1–3 px vertical drift caused by different font ascenders.
        if (((_b = spec.lineCount) !== null && _b !== void 0 ? _b : 1) === 1 && spec.height > 0) {
            text.y = targetY + (spec.height - text.height) / 2;
        }
        else {
            text.y = targetY;
        }
    }
    else {
        text.textAutoResize = 'NONE';
        text.resize(safeDimension(Math.max(1, spec.width)), safeDimension(Math.max(1, spec.height)));
        text.textAutoResize = 'HEIGHT';
    }
    return text;
}
async function makeImage(spec, parent, parentAbsX, parentAbsY, progress) {
    var _a;
    const rect = figma.createRectangle();
    parent.appendChild(rect);
    rect.name = compactLayerName(spec.name, 'Image');
    rect.x = spec.x - parentAbsX;
    rect.y = spec.y - parentAbsY;
    rect.resize(safeDimension(spec.width), safeDimension(spec.height));
    rect.opacity = clamp((_a = spec.opacity) !== null && _a !== void 0 ? _a : 1, 0, 1);
    applyCornerRadii(rect, spec.radius);
    setMetadata(rect, spec.metadata);
    try {
        const image = figma.createImage(asBytes(spec.bytes));
        rect.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: spec.fit }];
    }
    catch (_error) {
        rect.fills = [{ type: 'SOLID', color: { r: 0.92, g: 0.92, b: 0.92 } }];
        progress.warnings.add('Some images are unsupported by Figma or exceed the 4096 px limit.');
    }
    return rect;
}
async function makeSvg(spec, parent, parentAbsX, parentAbsY, progress) {
    var _a;
    try {
        const svg = figma.createNodeFromSvg(spec.markup);
        parent.appendChild(svg);
        svg.name = compactLayerName(spec.name, 'SVG');
        svg.x = spec.x - parentAbsX;
        svg.y = spec.y - parentAbsY;
        if ('resize' in svg)
            svg.resize(safeDimension(spec.width), safeDimension(spec.height));
        svg.opacity = clamp((_a = spec.opacity) !== null && _a !== void 0 ? _a : 1, 0, 1);
        setMetadata(svg, spec.metadata);
        return svg;
    }
    catch (_error) {
        progress.warnings.add('Some SVG files could not be parsed and were replaced with placeholders.');
        const placeholder = figma.createRectangle();
        parent.appendChild(placeholder);
        placeholder.name = 'Unsupported SVG';
        placeholder.x = spec.x - parentAbsX;
        placeholder.y = spec.y - parentAbsY;
        placeholder.resize(safeDimension(spec.width), safeDimension(spec.height));
        placeholder.fills = [];
        placeholder.strokes = [{ type: 'SOLID', color: { r: 0.8, g: 0.2, b: 0.2 } }];
        return placeholder;
    }
}
async function createNode(spec, parent, parentAbsX, parentAbsY, progress) {
    let node;
    if (spec.kind === 'frame')
        node = await makeFrame(spec, parent, parentAbsX, parentAbsY, progress);
    else if (spec.kind === 'text')
        node = await makeText(spec, parent, parentAbsX, parentAbsY, progress);
    else if (spec.kind === 'image')
        node = await makeImage(spec, parent, parentAbsX, parentAbsY, progress);
    else
        node = await makeSvg(spec, parent, parentAbsX, parentAbsY, progress);
    progress.done += 1;
    if (progress.done % 20 === 0 || progress.done === progress.total) {
        figma.ui.postMessage({ type: 'progress', done: progress.done, total: progress.total });
    }
    return node;
}
function countNodes(nodes) {
    var _a;
    let count = 0;
    for (const node of nodes) {
        count += 1;
        if (node.kind === 'frame')
            count += countNodes((_a = node.children) !== null && _a !== void 0 ? _a : []);
    }
    return count;
}
function placeRoot(root, batch) {
    if (!batch) {
        root.x = figma.viewport.center.x - root.width / 2;
        root.y = figma.viewport.center.y - Math.min(root.height, 1000) / 2;
        return null;
    }
    let state = batches.get(batch.id);
    if (!state) {
        state = {
            nextX: figma.viewport.center.x - root.width / 2,
            baseY: figma.viewport.center.y - Math.min(root.height, 1000) / 2,
            roots: [],
        };
        batches.set(batch.id, state);
    }
    root.x = state.nextX;
    root.y = state.baseY;
    state.nextX += root.width + 120;
    state.roots.push(root);
    return state;
}
function finishRoot(root, batch) {
    if (!batch) {
        figma.currentPage.selection = [root];
        figma.viewport.scrollAndZoomIntoView([root]);
        return;
    }
    const state = batches.get(batch.id);
    if (!state)
        return;
    if (batch.index === batch.total - 1) {
        figma.currentPage.selection = state.roots;
        figma.viewport.scrollAndZoomIntoView(state.roots);
        batches.delete(batch.id);
    }
}
async function importEditable(message) {
    var _a, _b;
    const root = figma.createFrame();
    const preset = ((_a = message.batch) === null || _a === void 0 ? void 0 : _a.presetLabel) ? ` — ${message.batch.presetLabel}` : '';
    root.name = compactLayerName(`${message.sourceName}${preset}`, 'Imported website');
    root.resize(safeDimension(message.width), safeDimension(message.height));
    root.layoutMode = 'NONE';
    root.clipsContent = true;
    root.fills = message.rootStyle.background && message.rootStyle.background.a > 0
        ? [rgbaToPaint(message.rootStyle.background)]
        : [];
    root.setPluginData('htmlSource', message.sourceName);
    if ((_b = message.batch) === null || _b === void 0 ? void 0 : _b.presetLabel)
        root.setPluginData('viewportPreset', message.batch.presetLabel);
    placeRoot(root, message.batch);
    const progress = {
        done: 0,
        total: countNodes(message.children),
        warnings: new Set(message.uiWarnings || []),
    };
    figma.ui.postMessage({ type: 'progress', done: 0, total: progress.total });
    for (const child of message.children)
        await createNode(child, root, 0, 0, progress);
    finishRoot(root, message.batch);
    figma.ui.postMessage({
        type: 'complete',
        mode: 'editable',
        warnings: Array.from(progress.warnings),
        batch: message.batch,
    });
}
async function importScreenshot(message) {
    var _a;
    const frame = figma.createFrame();
    const preset = ((_a = message.batch) === null || _a === void 0 ? void 0 : _a.presetLabel) ? ` — ${message.batch.presetLabel}` : '';
    frame.name = compactLayerName(`${message.sourceName}${preset} — Screenshot`, 'Imported website screenshot');
    frame.resize(safeDimension(message.width), safeDimension(message.height));
    frame.clipsContent = true;
    frame.fills = [];
    placeRoot(frame, message.batch);
    for (const [index, tile] of message.tiles.entries()) {
        const rect = figma.createRectangle();
        frame.appendChild(rect);
        rect.name = message.tiles.length === 1 ? 'Rendered page' : `Rendered page · tile ${index + 1}`;
        rect.x = tile.x;
        rect.y = tile.y;
        rect.resize(safeDimension(tile.width), safeDimension(tile.height));
        const image = figma.createImage(asBytes(tile.bytes));
        rect.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: 'FILL' }];
    }
    finishRoot(frame, message.batch);
    figma.ui.postMessage({ type: 'complete', mode: 'screenshot', warnings: [], batch: message.batch });
}
figma.ui.onmessage = async (message) => {
    if (message.type === 'cancel') {
        figma.closePlugin();
        return;
    }
    try {
        if (message.type === 'import-editable')
            await importEditable(message);
        else if (message.type === 'import-screenshot')
            await importScreenshot(message);
    }
    catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        figma.ui.postMessage({ type: 'error', message: text });
    }
};
