const fs = require('fs');

const filePath = 'c:\\Users\\laugh\\Documents\\Webapp\\dorm-manager\\components\\admin\\invoices\\InvoiceDetailModal.tsx';
const lines = fs.readFileSync(filePath, 'utf8').split('\n');

function findLine(str, startIdx = 0) {
    for (let i = startIdx; i < lines.length; i++) {
        if (lines[i].includes(str)) return i;
    }
    return -1;
}

// 1. Top wrapper
const topWrapperIdx = findLine('<div className="space-y-6">');

// 2. Start of table grid (where we switch to right column)
const gridStartIdx = findLine('<div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(300px,440px)]');
const fieldsetStartIdx = findLine('<fieldset', gridStartIdx);

// 3. End of right column components
const quickMenuStartIdx = findLine('<div className="space-y-3">'); // "เมนูด่วน"
const quickMenuLabelIdx = findLine('เมนูด่วน', quickMenuStartIdx);

// 4. End of modal content
const endIdx = findLine('</Modal>');

console.log({ topWrapperIdx, gridStartIdx, fieldsetStartIdx, quickMenuStartIdx, quickMenuLabelIdx, endIdx });

if (topWrapperIdx > -1 && gridStartIdx > -1 && quickMenuStartIdx > -1 && endIdx > -1) {
    // Left column content = lines from topWrapperIdx + 1 to gridStartIdx - 1
    // PLUS the quick menu & save buttons (quickMenuStartIdx to endIdx - 2)
    // Right column content = lines from fieldsetStartIdx to quickMenuStartIdx - 1 (removing the grid wrappers)

    const warningsAndHeaderAndPayments = lines.slice(topWrapperIdx + 1, gridStartIdx);
    
    // Extract the quick menu and save buttons
    let endOfContentIdx = endIdx - 1;
    while (lines[endOfContentIdx].trim() === ')}' || lines[endOfContentIdx].trim() === '</div>') {
        endOfContentIdx--;
    }
    // Actually the quick menu goes from quickMenuStartIdx to endOfContentIdx (which is just before `)}` and `</Modal>`)
    const quickMenuAndSave = lines.slice(quickMenuStartIdx, endOfContentIdx + 1);

    // Extract right column
    // But we need to remove the closing divs of the old grid.
    // The old grid closed right before quickMenuStartIdx. Let's look at the lines before quickMenuStartIdx
    let rightColumn = lines.slice(fieldsetStartIdx, quickMenuStartIdx);
    
    // Remove the trailing closing divs from right column
    while (rightColumn[rightColumn.length - 1].trim() === '</div>') {
        rightColumn.pop();
    }

    // Assemble new content
    const newContent = [
        ...lines.slice(0, topWrapperIdx),
        '        <div className="flex flex-col xl:flex-row gap-6 h-full max-h-[85vh]">',
        '          {/* --- LEFT COLUMN: Overview & Actions --- */}',
        '          <div className="w-full xl:w-[420px] shrink-0 flex flex-col gap-5 overflow-y-auto pr-2 pb-4">',
        ...warningsAndHeaderAndPayments,
        ...quickMenuAndSave,
        '          </div>',
        '',
        '          {/* --- RIGHT COLUMN: Detailed Breakdown --- */}',
        '          <div className="flex-1 min-w-0 flex flex-col gap-6 overflow-y-auto pr-2 pb-4">',
        '            <div className="grid items-start gap-6 xl:grid-cols-1 2xl:grid-cols-[1fr_400px]">',
        ...rightColumn,
        '            </div>',
        '          </div>',
        '        </div>',
        '      )}',
        '    </Modal>',
        '  );',
        '}'
    ];

    fs.writeFileSync(filePath + '.new.tsx', newContent.join('\n'), 'utf8');
    console.log("Wrote to .new.tsx");
} else {
    console.log("Failed to find boundaries");
}
