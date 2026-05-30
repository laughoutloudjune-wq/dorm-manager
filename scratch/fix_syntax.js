const fs = require('fs');
let code = fs.readFileSync('components/admin/tenant-editor-modal.tsx', 'utf8');

const replacements = [
  ['setState({ transferCalc: (prev }) => ({', 'setState(s => ({ transferCalc: { ...s.transferCalc,'],
  ['setState({ depositSlipUrls: (prev }) => {', 'setState(s => { const prev = s.depositSlipUrls;'],
  ['setState({ depositSlipUrls: (prev }) => prev.filter((item) => item !== url));', 'setState(s => ({ depositSlipUrls: s.depositSlipUrls.filter((item) => item !== url) }));'],
  ['setState({ transferCalc: (prev }) => ({ ...prev, transfer_date: event.target.value }))', 'setState(s => ({ transferCalc: { ...s.transferCalc, transfer_date: event.target.value } }))'],
  ['setState({ latestPrevElectricity: toNumber((data as any })?.current_electricity ?? fallbackElectric));', 'setState({ latestPrevElectricity: toNumber((data as any)?.current_electricity ?? fallbackElectric) });'],
  ['setState({ latestPrevWater: toNumber((data as any })?.current_water ?? fallbackWater));', 'setState({ latestPrevWater: toNumber((data as any)?.current_water ?? fallbackWater) });'],
  ['setState({ transferCalc: {\\n        transfer_date: new Date( }).toISOString().slice(0, 10),', 'setState({ transferCalc: {\\n        transfer_date: new Date().toISOString().slice(0, 10),'],
  ['setState({ transferCalc: {\\n        transfer_date: new Date( }).toISOString().slice(0, 10)', 'setState({ transferCalc: {\\n        transfer_date: new Date().toISOString().slice(0, 10)']
];

for (const [find, replace] of replacements) {
  code = code.split(find).join(replace);
}

// Fix lines ending with s => { const prev = s.depositSlipUrls;
// They will need to return the new state object: `return { depositSlipUrls: ... }; }`
code = code.replace(/setState\(s => \{ const prev = s.depositSlipUrls;\n      const newUrls = \[\.\.\.prev, data\.publicUrl\];\n      return newUrls;\n    \}\);/g, 'setState(s => ({ depositSlipUrls: [...s.depositSlipUrls, data.publicUrl] }));');


fs.writeFileSync('components/admin/tenant-editor-modal.tsx', code);
console.log('Fixed syntax errors!');
