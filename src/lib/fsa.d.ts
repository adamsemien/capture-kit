// File System Access bits TypeScript's DOM lib still doesn't ship.
//
// showDirectoryPicker and the permission methods are implemented in Chrome
// (verified live on 151 by the NOBC-82 spike) but are not in lib.dom, so they
// are declared here rather than cast away at every call site.

interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

interface FileSystemHandle {
  queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

interface DirectoryPickerOptions {
  /** Remembers a per-purpose starting directory between picks. */
  id?: string;
  mode?: 'read' | 'readwrite';
  startIn?: FileSystemHandle | string;
}

declare function showDirectoryPicker(
  options?: DirectoryPickerOptions,
): Promise<FileSystemDirectoryHandle>;
