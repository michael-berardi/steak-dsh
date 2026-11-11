/** Named launcher errors. The message always names the cause; the bin prints it as `steak-dsh: <message>`. */

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
    this.exitCode = 2;
  }
}

export class MissingDshError extends Error {
  constructor(message) {
    super(message);
    this.name = "MissingDshError";
    this.exitCode = 78;
  }
}
