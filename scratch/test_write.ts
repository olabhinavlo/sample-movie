const data = new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode("Hello from Stream!"));
    controller.close();
  }
});

// Test 1: Bun.write directly with ReadableStream
await Bun.write("scratch_test_1.txt", data);
console.log("Test 1 file size:", Bun.file("scratch_test_1.txt").size);

// Test 2: Bun.write with new Response(ReadableStream)
const data2 = new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode("Hello from Stream 2!"));
    controller.close();
  }
});
await Bun.write("scratch_test_2.txt", new Response(data2));
console.log("Test 2 file size:", Bun.file("scratch_test_2.txt").size);
