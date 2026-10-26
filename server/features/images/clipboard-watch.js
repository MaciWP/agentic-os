// The clipboard watcher on macOS (JXA). argv: server pid, byte cap, pasteboard name (tests
// only; the general pasteboard by default). Prints one JSON line per copied image, as PNG in
// base64, and ends when the server does: an orphan's parent becomes launchd.
ObjC.import("AppKit");
ObjC.import("unistd");

// biome-ignore lint/correctness/noUnusedVariables: osascript calls run with the arguments
function run(argv) {
  const server = Number(argv[0]);
  const max = Number(argv[1]);
  const board = argv[2]
    ? $.NSPasteboard.pasteboardWithName(argv[2])
    : $.NSPasteboard.generalPasteboard;
  const out = $.NSFileHandle.fileHandleWithStandardOutput;
  const say = (line) =>
    out.writeData($(`${JSON.stringify(line)}\n`).dataUsingEncoding($.NSUTF8StringEncoding));
  // What is on the clipboard already is not news.
  let seen = Number(board.changeCount);
  say({ ready: true });
  while ($.getppid() === server) {
    const change = Number(board.changeCount);
    if (change !== seen) {
      seen = change;
      const types = ObjC.deepUnwrap(board.types) || [];
      let png = null;
      // A file copied in Finder brings its icon; that is not an image the user copied.
      if (!types.includes("public.file-url")) {
        if (types.includes("public.png")) png = board.dataForType("public.png");
        else if (types.includes("public.tiff")) {
          const rep = $.NSBitmapImageRep.imageRepWithData(board.dataForType("public.tiff"));
          if (!rep.isNil())
            png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
        }
      }
      if (png && !png.isNil()) {
        if (Number(png.length) > max) say({ tooLarge: Number(png.length) });
        else say({ image: ObjC.unwrap(png.base64EncodedStringWithOptions(0)) });
      }
    }
    delay(0.5);
  }
}
