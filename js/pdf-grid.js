(function () {
  const drop = document.getElementById('pdf-drop');
  const fileInput = document.getElementById('pdf-fileInput');
  const fileInfo = document.getElementById('pdf-fileInfo');
  const fileNameEl = document.getElementById('pdf-fileName');
  const clearBtn = document.getElementById('pdf-clearFile');
  const goBtn = document.getElementById('pdf-go');
  const statusEl = document.getElementById('pdf-status');
  const singleSidedBtn = document.getElementById('pdf-singleSided');
  const doubleSidedBtn = document.getElementById('pdf-doubleSided');
  const grid3x3Btn = document.getElementById('pdf-grid3x3');
  const grid2x4Btn = document.getElementById('pdf-grid2x4');

  let selectedFile = null;
  let frontBackMode = true;
  let layoutKey = 'grid3x3';

  function setSided(isDouble) {
    frontBackMode = isDouble;
    doubleSidedBtn.classList.toggle('active', isDouble);
    singleSidedBtn.classList.toggle('active', !isDouble);
  }

  function setLayout(key) {
    layoutKey = key;
    grid3x3Btn.classList.toggle('active', key === 'grid3x3');
    grid2x4Btn.classList.toggle('active', key === 'grid2x4');
  }

  singleSidedBtn.addEventListener('click', () => setSided(false));
  doubleSidedBtn.addEventListener('click', () => setSided(true));
  grid3x3Btn.addEventListener('click', () => setLayout('grid3x3'));
  grid2x4Btn.addEventListener('click', () => setLayout('grid2x4'));

  function setFile(file) {
    if (!file) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      showStatus('That file doesn\'t look like a PDF. Please choose a .pdf file.', true);
      return;
    }
    selectedFile = file;
    fileNameEl.textContent = file.name;
    fileInfo.style.display = 'flex';
    goBtn.disabled = false;
    showStatus('');
  }

  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('hover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('hover'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('hover');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) setFile(e.target.files[0]);
  });
  clearBtn.addEventListener('click', () => {
    selectedFile = null;
    fileInput.value = '';
    fileInfo.style.display = 'none';
    goBtn.disabled = true;
    showStatus('');
  });

  function showStatus(msg, isError) {
    statusEl.innerHTML = msg || '';
    statusEl.className = isError ? 'error' : '';
  }

  goBtn.addEventListener('click', async () => {
    if (!selectedFile) return;
    goBtn.disabled = true;
    showStatus('Reading PDF…');

    try {
      const inputBytes = await selectedFile.arrayBuffer();

      showStatus('Laying out the grid…');
      const { PDFDocument, rgb } = PDFLib;

      const srcDoc = await PDFDocument.load(inputBytes);
      const totalPages = srcDoc.getPageCount();
      if (totalPages === 0) throw new Error('That PDF has no pages.');

      const firstPage = srcDoc.getPage(0);
      const srcW = firstPage.getWidth();
      const srcH = firstPage.getHeight();

      // Two layouts, each with its own sheet size, cell sizing strategy, and
      // front/back mirror axis (which axis flips depends on which edge the
      // physical sheet turns on when you flip it over to print/align the back).
      let COLS, ROWS, outW, outH, cellW, cellH, scaledW, scaledH, offsetX, offsetY, mirrorAxis, drawOuterBorder;

      if (layoutKey === 'grid3x3') {
        COLS = 3; ROWS = 3;
        outW = srcW; outH = srcH;              // sheet = same size as source pages
        cellW = outW / COLS; cellH = outH / ROWS;
        const scale = Math.min(cellW / srcW, cellH / srcH);
        scaledW = srcW * scale; scaledH = srcH * scale;   // scaled to fill each cell
        offsetX = 0; offsetY = 0;               // no margin, edge-to-edge
        mirrorAxis = 'col';                     // long-edge flip -> mirror columns
        drawOuterBorder = false;                // no whitespace to trim
      } else {
        // grid2x4: landscape US Letter, tags kept at native size, centered
        COLS = 4; ROWS = 2;
        outW = 792; outH = 612;                 // US Letter landscape, in points
        scaledW = srcW; scaledH = srcH;          // no scaling - use actual tag size
        cellW = scaledW; cellH = scaledH;        // cells packed tight, no gap
        const blockW = cellW * COLS;
        const blockH = cellH * ROWS;
        offsetX = (outW - blockW) / 2;
        offsetY = (outH - blockH) / 2;
        if (blockW > outW || blockH > outH) {
          throw new Error(
            'Your tag pages are too large to fit 4×2 on a landscape US Letter sheet ' +
            '(tags are ' + (srcW/72).toFixed(2) + '×' + (srcH/72).toFixed(2) + 'in). ' +
            'Try the 3×3 layout instead.'
          );
        }
        mirrorAxis = 'col';                      // flips on the same axis as the 3x3 layout
        drawOuterBorder = true;                  // border around the block, for trimming the margin
      }

      const perSheet = COLS * ROWS;

      const outDoc = await PDFDocument.create();

      // embed every source page once as reusable vector content (not rasterized),
      // then stamp it into as many grid cells as needed
      const indices = [];
      for (let i = 0; i < totalPages; i++) indices.push(i);
      const embeddedPages = await outDoc.embedPdf(inputBytes, indices);

      function drawCutLines(page) {
        for (let c = 1; c < COLS; c++) {
          const lx = offsetX + c * cellW;
          page.drawLine({
            start: { x: lx, y: offsetY }, end: { x: lx, y: offsetY + ROWS * cellH },
            thickness: 0.75, color: rgb(0.5, 0.5, 0.5), dashArray: [3, 3],
          });
        }
        for (let r = 1; r < ROWS; r++) {
          const ly = offsetY + r * cellH;
          page.drawLine({
            start: { x: offsetX, y: ly }, end: { x: offsetX + COLS * cellW, y: ly },
            thickness: 0.75, color: rgb(0.5, 0.5, 0.5), dashArray: [3, 3],
          });
        }
        if (drawOuterBorder) {
          page.drawRectangle({
            x: offsetX, y: offsetY, width: COLS * cellW, height: ROWS * cellH,
            borderColor: rgb(0.5, 0.5, 0.5), borderWidth: 0.75, borderDashArray: [3, 3],
          });
        }
      }

      function place(page, embeddedIdx, col, row) {
        const cellLeft = offsetX + col * cellW;
        const cellBottom = offsetY + (ROWS - 1 - row) * cellH;
        const x = cellLeft + (cellW - scaledW) / 2;
        const y = cellBottom + (cellH - scaledH) / 2;
        page.drawPage(embeddedPages[embeddedIdx], { x, y, width: scaledW, height: scaledH });
      }

      function mirror(col, row) {
        return mirrorAxis === 'col'
          ? { col: (COLS - 1) - col, row }
          : { col, row: (ROWS - 1) - row };
      }

      let tagCount, sheetCount, oddLeftover;

      if (frontBackMode) {
        tagCount = Math.floor(totalPages / 2);
        oddLeftover = totalPages % 2 !== 0;
        sheetCount = Math.ceil(tagCount / perSheet);

        for (let s = 0; s < sheetCount; s++) {
          const frontPage = outDoc.addPage([outW, outH]);
          const backPage = outDoc.addPage([outW, outH]);

          for (let i = 0; i < perSheet; i++) {
            const tagIdx = s * perSheet + i;
            if (tagIdx >= tagCount) break;

            const row = Math.floor(i / COLS);
            const col = i % COLS;
            const mirrored = mirror(col, row);

            const frontSrcIdx = tagIdx * 2;
            const backSrcIdx = tagIdx * 2 + 1;

            place(frontPage, frontSrcIdx, col, row);
            place(backPage, backSrcIdx, mirrored.col, mirrored.row);
          }

          drawCutLines(frontPage);
          drawCutLines(backPage);
        }
      } else {
        tagCount = totalPages;
        oddLeftover = false;
        sheetCount = Math.ceil(tagCount / perSheet);

        for (let s = 0; s < sheetCount; s++) {
          const page = outDoc.addPage([outW, outH]);

          for (let i = 0; i < perSheet; i++) {
            const idx = s * perSheet + i;
            if (idx >= tagCount) break;
            const row = Math.floor(i / COLS);
            const col = i % COLS;
            place(page, idx, col, row);
          }

          drawCutLines(page);
        }
      }

      showStatus('Finishing up…');
      const outBytes = await outDoc.save();
      const blob = new Blob([outBytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);

      const layoutSuffix = layoutKey === 'grid3x3' ? '_3x3_grid' : '_2x4_grid';
      const outName = selectedFile.name.replace(/\.pdf$/i, '') + layoutSuffix + '.pdf';
      const sheetWord = frontBackMode
        ? sheetCount + ' front/back sheet pair' + (sheetCount === 1 ? '' : 's') + ' (' + (sheetCount * 2) + ' pages)'
        : sheetCount + ' sheet' + (sheetCount === 1 ? '' : 's');
      let msg = 'Done: ' + tagCount + ' tags across ' + sheetWord + '.';
      if (oddLeftover) {
        msg += '<br><span style="color:#a3402f">Note: the PDF had an odd number of pages, ' +
               'so the last page was ignored (no matching back).</span>';
      }
      msg += '<br><a href="' + url + '" download="' + outName + '">Download grid PDF</a>';
      showStatus(msg);
    } catch (err) {
      console.error(err);
      showStatus('Something went wrong: ' + err.message, true);
    } finally {
      goBtn.disabled = false;
    }
  });
})();
