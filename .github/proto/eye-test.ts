// Scratch only: load Eye's native core on Windows from Bun and analyse a synthetic image.
const models = process.argv[2]!;
const { Eye } = await import("@desert-ant-labs/eye/native");
let t = performance.now();
const eye = await Eye.load({ directory: models });
console.log("loaded", Math.round(performance.now() - t), "ms");
const width = 512, height = 384, data = new Uint8Array(width * height * 4);
for (let i = 0; i < data.length; i++) data[i] = (i * 7) & 255;
for (let n = 0; n < 3; n++) {
    t = performance.now();
    const a = await eye.analyze({ data, width, height });
    console.log("analyze", Math.round(performance.now() - t), "ms", JSON.stringify(a).slice(0, 160));
}
eye.dispose();
