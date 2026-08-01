//go:build unix

package npy

import "syscall"

func mapFile(fd, size int) ([]byte, error) {
	return syscall.Mmap(fd, 0, size, syscall.PROT_READ, syscall.MAP_SHARED)
}

func unmapFile(b []byte) error { return syscall.Munmap(b) }
