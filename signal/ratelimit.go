package main

import (
	"sync"
	"time"
)

// RateLimiter is a per-key sliding-window counter. Used to enforce
// "10 pairing sessions per IP per minute" (protocol.md §7).
type RateLimiter struct {
	mu     sync.Mutex
	window time.Duration
	limit  int
	hits   map[string][]time.Time
}

func NewRateLimiter(limit int, window time.Duration) *RateLimiter {
	return &RateLimiter{
		window: window,
		limit:  limit,
		hits:   make(map[string][]time.Time),
	}
}

// Allow reports whether key may perform one more action now, and records it
// if so.
func (r *RateLimiter) Allow(key string) bool {
	now := time.Now()
	r.mu.Lock()
	defer r.mu.Unlock()

	cutoff := now.Add(-r.window)
	hits := r.hits[key]
	kept := hits[:0]
	for _, t := range hits {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}

	if len(kept) >= r.limit {
		r.hits[key] = kept
		return false
	}

	r.hits[key] = append(kept, now)
	return true
}

// Sweep drops keys with no hits inside the window, so the map does not grow
// unboundedly for a long-running process. Call periodically.
func (r *RateLimiter) Sweep() {
	now := time.Now()
	cutoff := now.Add(-r.window)
	r.mu.Lock()
	defer r.mu.Unlock()
	for key, hits := range r.hits {
		alive := hits[:0]
		for _, t := range hits {
			if t.After(cutoff) {
				alive = append(alive, t)
			}
		}
		if len(alive) == 0 {
			delete(r.hits, key)
		} else {
			r.hits[key] = alive
		}
	}
}
