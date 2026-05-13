/* Rename Chromaprint's KissFFT function symbols to avoid conflict with QM's KissFFT.
   Only rename functions, NOT types (kiss_fft_scalar, kiss_fft_cpx) since they
   are used in typedef/struct definitions and renaming them breaks compilation. */
#ifndef CHROMAPRINT_KISSFFT_SYMBOL_RENAME_H
#define CHROMAPRINT_KISSFFT_SYMBOL_RENAME_H

#define kiss_fft_alloc          chromaprint_kiss_fft_alloc
#define kiss_fft_init           chromaprint_kiss_fft_init
#define kiss_fft                chromaprint_kiss_fft
#define kiss_fft_free           chromaprint_kiss_fft_free
#define kiss_fft_stride         chromaprint_kiss_fft_stride
#define kiss_fftr_alloc         chromaprint_kiss_fftr_alloc
#define kiss_fftr_init          chromaprint_kiss_fftr_init
#define kiss_fftr               chromaprint_kiss_fftr
#define kiss_fftr_free          chromaprint_kiss_fftr_free
#define kiss_fftri              chromaprint_kiss_fftri
#define kiss_fftr2              chromaprint_kiss_fftr2
#define kiss_fft_cleanup        chromaprint_kiss_fft_cleanup
#define kiss_fft_next_fast_size chromaprint_kiss_fft_next_fast_size

#endif
