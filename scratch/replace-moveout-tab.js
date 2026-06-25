const fs = require('fs');

const filePath = 'c:\\Users\\laugh\\Documents\\Webapp\\dorm-manager\\components\\admin\\tenant-editor-modal.tsx';
let content = fs.readFileSync(filePath, 'utf8');

// The broken section to fix: lines 662-691 (0-indexed: 661-690)
// We'll do a string replacement on the exact broken content

const broken = `  const deleteTenant = async () => {\r
const confirmMoveOut = async () => {\r
    if (!activeTenant) return;\r
    setIsMovingOut(true);\r
    const moveOutDate = form.final_move_out_date || new Date().toISOString().slice(0, 10);\r
    try {\r
      await callTenantsAction("final_move_out", {\r
        tenantId: activeTenant.id,\r
        payload: {\r
          forfeitDeposit,\r
          move_out_date: moveOutDate,\r
          meterData: {\r
            initial_electricity: latestPrevElectricity,\r
            initial_water: latestPrevWater,\r
            final_electricity: toNumber(form.final_electricity_reading),\r
            final_water: toNumber(form.final_water_reading),\r
          },\r
          moveOutFeeLines,\r
        },\r
      });\r
    } catch (error: any) {\r
      setStatus(error?.message ?? "\u0e22\u0e37\u0e19\u0e22\u0e31\u0e19\u0e01\u0e32\u0e23\u0e22\u0e49\u0e32\u0e22\u0e2d\u0e2d\u0e01\u0e44\u0e21\u0e48\u0e2a\u0e33\u0e40\u0e23\u0e47\u0e08");\r
      setIsMovingOut(false);\r
      return;\r
    }\r
    setStatus("\u0e22\u0e37\u0e19\u0e22\u0e31\u0e19\u0e01\u0e32\u0e23\u0e22\u0e49\u0e32\u0e22\u0e2d\u0e2d\u0e01\u0e40\u0e23\u0e35\u0e22\u0e1a\u0e23\u0e49\u0e2d\u0e22");\r
    onClose();\r
    await loadTenants();\r
    setIsMovingOut(false);\r
  };`;

const fixed = `  const deleteTenant = async () => {\r
    if (!activeTenant) return;\r
    setIsDeletingTenant(true);\r
    try {\r
      await callTenantsAction("delete_tenant", { tenantId: activeTenant.id });\r
    } catch (error: any) {\r
      setStatus(error?.message ?? "\u0e25\u0e1a\u0e1c\u0e39\u0e49\u0e40\u0e0a\u0e48\u0e32\u0e44\u0e21\u0e48\u0e2a\u0e33\u0e40\u0e23\u0e47\u0e08");\r
      setIsDeletingTenant(false);\r
      return;\r
    }\r
    setStatus("\u0e25\u0e1a\u0e1c\u0e39\u0e49\u0e40\u0e0a\u0e48\u0e32\u0e40\u0e23\u0e35\u0e22\u0e1a\u0e23\u0e49\u0e2d\u0e22");\r
    onClose();\r
    await loadTenants();\r
    setIsDeletingTenant(false);\r
  };\r
\r
  const unlinkTenantLine = async () => {\r
    if (!activeTenant) return;\r
    setIsUnlinkingLine(true);\r
    try {\r
      await callTenantsAction("unlink_line", { tenantId: activeTenant.id });\r
    } catch (error: any) {\r
      setStatus(error?.message ?? "\u0e22\u0e01\u0e40\u0e25\u0e34\u0e01\u0e01\u0e32\u0e23\u0e40\u0e0a\u0e37\u0e48\u0e2d\u0e21 LINE \u0e44\u0e21\u0e48\u0e2a\u0e33\u0e40\u0e23\u0e47\u0e08");\r
      setIsUnlinkingLine(false);\r
      return;\r
    }\r
    setActiveTenant({ ...activeTenant, line_user_id: null });\r
    setStatus("\u0e22\u0e01\u0e40\u0e25\u0e34\u0e01\u0e01\u0e32\u0e23\u0e40\u0e0a\u0e37\u0e48\u0e2d\u0e21 LINE \u0e40\u0e23\u0e35\u0e22\u0e1a\u0e23\u0e49\u0e2d\u0e22");\r
    await loadTenants();\r
    setIsUnlinkingLine(false);\r
  };\r
\r
  const confirmMoveOut = async () => {\r
    if (!activeTenant) return;\r
    setIsMovingOut(true);\r
    const moveOutDate = form.final_move_out_date || new Date().toISOString().slice(0, 10);\r
    try {\r
      await callTenantsAction("final_move_out", {\r
        tenantId: activeTenant.id,\r
        payload: {\r
          forfeitDeposit,\r
          move_out_date: moveOutDate,\r
          meterData: {\r
            initial_electricity: latestPrevElectricity,\r
            initial_water: latestPrevWater,\r
            final_electricity: toNumber(form.final_electricity_reading),\r
            final_water: toNumber(form.final_water_reading),\r
          },\r
          moveOutFeeLines,\r
        },\r
      });\r
    } catch (error: any) {\r
      setStatus(error?.message ?? "\u0e22\u0e37\u0e19\u0e22\u0e31\u0e19\u0e01\u0e32\u0e23\u0e22\u0e49\u0e32\u0e22\u0e2d\u0e2d\u0e01\u0e44\u0e21\u0e48\u0e2a\u0e33\u0e40\u0e23\u0e47\u0e08");\r
      setIsMovingOut(false);\r
      return;\r
    }\r
    setStatus("\u0e22\u0e37\u0e19\u0e22\u0e31\u0e19\u0e01\u0e32\u0e23\u0e22\u0e49\u0e32\u0e22\u0e2d\u0e2d\u0e01\u0e40\u0e23\u0e35\u0e22\u0e1a\u0e23\u0e49\u0e2d\u0e22");\r
    onClose();\r
    await loadTenants();\r
    setIsMovingOut(false);\r
  };`;

if (content.includes(broken)) {
  content = content.replace(broken, fixed);
  fs.writeFileSync(filePath, content, 'utf8');
  console.log('Fixed! Lines:', content.split('\n').length);
} else {
  // Try without \r
  const brokenNoR = broken.replace(/\r\n/g, '\n');
  const fixedNoR = fixed.replace(/\r\n/g, '\n');
  if (content.includes(brokenNoR)) {
    content = content.replace(brokenNoR, fixedNoR);
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('Fixed (LF)! Lines:', content.split('\n').length);
  } else {
    // Just find and replace the bad line
    const lines = content.split(/\r?\n/);
    const idx = lines.findIndex(l => l.trim() === 'const confirmMoveOut = async () => {' && lines[idx2 = lines.indexOf(l) - 1]?.trim() === 'const deleteTenant = async () => {');
    console.log('Could not find broken section via string. Trying line-based...');
    
    // Find the broken line at position 663 (0-indexed 662)
    const line663 = lines[662];
    console.log('Line 663:', JSON.stringify(line663));
    const line662 = lines[661];
    console.log('Line 662:', JSON.stringify(line662));
  }
}
