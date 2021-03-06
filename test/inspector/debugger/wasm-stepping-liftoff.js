// Copyright 2020 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// Flags: --debug-in-liftoff

let {session, contextGroup, Protocol} =
    InspectorTest.start('Tests stepping through wasm scripts by byte offsets');

utils.load('test/mjsunit/wasm/wasm-module-builder.js');

var builder = new WasmModuleBuilder();

var func_a_idx =
    builder.addFunction('wasm_A', kSig_v_i).addBody([kExprNop, kExprNop]).index;

// wasm_B calls wasm_A <param0> times.
var func_b = builder.addFunction('wasm_B', kSig_v_i)
    .addBody([
      // clang-format off
      kExprLoop, kWasmStmt,               // while
        kExprLocalGet, 0,                 // -
        kExprIf, kWasmStmt,               // if <param0> != 0
          kExprLocalGet, 0,               // -
          kExprI32Const, 1,               // -
          kExprI32Sub,                    // -
          kExprLocalSet, 0,               // decrease <param0>
          ...wasmI32Const(1024),          // some longer i32 const (2 byte imm)
          kExprCallFunction, func_a_idx,  // -
          kExprBr, 1,                     // continue
          kExprEnd,                       // -
        kExprEnd,                         // break
      // clang-format on
    ])
    .exportAs('main');

let fact = builder.addFunction('fact', kSig_i_i)
    .addLocals({i32_count: 1})
    .addBody([
    // clang-format off
    kExprLocalGet, 0,
    kExprIf, kWasmI32,               // if <param0> != 0
      kExprLocalGet, 0,
      kExprI32Const, 1,
      kExprI32Sub,
      kExprCallFunction, 2,
      kExprLocalGet, 0,
      kExprI32Mul,                   //   return fact(<param0> - 1) * <param0>
    kExprElse,                       // else
      kExprI32Const, 1,              //   return 1
    kExprEnd,
    // clang-format on
  ])
  .exportAs('fact');

var module_bytes = builder.toArray();

function instantiate(bytes) {
  var buffer = new ArrayBuffer(bytes.length);
  var view = new Uint8Array(buffer);
  for (var i = 0; i < bytes.length; ++i) {
    view[i] = bytes[i] | 0;
  }

  var module = new WebAssembly.Module(buffer);
  // Set global variable.
  instance = new WebAssembly.Instance(module);
}

(async function test() {
  for (const action of ['stepInto', 'stepOver', 'stepOut', 'resume'])
    InspectorTest.logProtocolCommandCalls('Debugger.' + action);

  await Protocol.Debugger.enable();
  InspectorTest.log('Setting up global instance variable.');
  Protocol.Runtime.evaluate({
    expression: `var instance;` +
        `(${instantiate.toString()})(${JSON.stringify(module_bytes)})`
  });
  const [, {params: wasmScript}] = await Protocol.Debugger.onceScriptParsed(2);

  InspectorTest.log('Got wasm script: ' + wasmScript.url);

  // Set the breakpoint on a non-breakable position. This should resolve to the
  // next instruction.
  var offset = func_b.body_offset + 15;
  InspectorTest.log(
      `Setting breakpoint on offset ` + offset + ` (should be propagated to ` +
        (offset + 1) + `, the offset of the call), url ${wasmScript.url}`);
  let bpmsg = await Protocol.Debugger.setBreakpoint({
    location: {scriptId: wasmScript.scriptId, lineNumber: 0, columnNumber: offset}
  });

  InspectorTest.logMessage(bpmsg.result.actualLocation);
  Protocol.Runtime.evaluate({ expression: 'instance.exports.main(4)' });
  await waitForPauseAndStep('stepOver');  // over call to wasm_A
  await waitForPauseAndStep('resume');    // stop on breakpoint
  await waitForPauseAndStep('stepOver');  // over call
  await waitForPauseAndStep('stepOver');  // over br
  await waitForPauseAndStep('resume');    // to next breakpoint (3rd iteration)
  await waitForPauseAndStep('stepOver');  // over wasm_A
  // Step over 10 times.
  for (let i = 0; i < 10; ++i) await waitForPauseAndStep('stepOver');
  // Then just resume.
  await waitForPauseAndStep('resume');
  InspectorTest.log('exports.main returned!');

  InspectorTest.log('Test stepping over a recursive call');
  // Set a breakpoint at the recursive call and run.
  offset = fact.body_offset + 9; // Offset of the recursive call instruction.
  InspectorTest.log(
      `Setting breakpoint on the recursive call instruction @+` + offset +
      `, url ${wasmScript.url}`);
  bpmsg = await Protocol.Debugger.setBreakpoint({
    location: {scriptId: wasmScript.scriptId, lineNumber: 0, columnNumber: offset}
  });
  actualLocation = bpmsg.result.actualLocation;
  InspectorTest.logMessage(actualLocation);
  Protocol.Runtime.evaluate({ expression: 'instance.exports.fact(4)' });
  await waitForPause();

  // Remove the breakpoint before stepping over.
  InspectorTest.log('Removing breakpoint');
  let breakpointId = bpmsg.result.breakpointId;
  await Protocol.Debugger.removeBreakpoint({breakpointId});
  await Protocol.Debugger.stepOver();
  await waitForPauseAndStep('resume');
  InspectorTest.log('Finished!');
})().catch(reason => InspectorTest.log(`Failed: ${reason}`))
    .finally(InspectorTest.completeTest);

async function waitForPauseAndStep(stepAction) {
  await waitForPause();
  Protocol.Debugger[stepAction]();
}

async function waitForPause() {
  const {params: {callFrames}} = await Protocol.Debugger.oncePaused();
  const topFrame = callFrames[0];
  InspectorTest.log(
      `Paused at ${topFrame.url}:${topFrame.location.lineNumber}:${topFrame.location.columnNumber}`);
}
