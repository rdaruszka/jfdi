/**
 * Shell exit-code conventions JFDI reproduces, so a caller or wrapper script
 * reads them the way it reads any other command's.
 */

/** The command could not be executed: not found, or not executable. */
export const EXIT_COMMAND_NOT_EXECUTABLE = 127;

// Killed by a signal is reported as 128 + the signal number.
export const EXIT_SIGINT = 130;
export const EXIT_SIGTERM = 143;
