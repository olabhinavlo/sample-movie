const dataStream = new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode("Hello Chunk 1!\n"));
    controller.enqueue(new TextEncoder().encode("Hello Chunk 2!\n"));
    controller.close();
  }
});

const filePath = "scratch_test_writer.txt";
const writer = Bun.file(filePath).writer();
const reader = dataStream.getReader();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  writer.write(value);
}
writer.end();

console.log("Written file size:", Bun.file(filePath).size);
console.log("File content:\n", await Bun.file(filePath).text());
