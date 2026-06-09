/**
 * FRKB FFmpeg decode wrapper.
 * Decodes audio files using libavcodec/libavformat/libswresample.
 * Provides direct Chromaprint fingerprint generation.
 */

#include "frkb_ffmpeg_decode_wrapper.h"
#include "chromaprint.h"

#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <libavutil/opt.h>
#include <libavutil/channel_layout.h>
#include <libswresample/swresample.h>

#include <stdlib.h>
#include <string.h>
#include <stdint.h>

/* Error codes */
#define FRKB_ERR_OPEN_INPUT     1
#define FRKB_ERR_STREAM_INFO    2
#define FRKB_ERR_NO_AUDIO       3
#define FRKB_ERR_OPEN_CODEC     4
#define FRKB_ERR_SWR_INIT       5
#define FRKB_ERR_ALLOC          6
#define FRKB_ERR_CHROMAPRINT    7

/* Target output format: interleaved s16, stereo */
#define TARGET_SAMPLE_FMT AV_SAMPLE_FMT_S16
#define TARGET_CHANNELS   2

/**
 * Decode context holding all FFmpeg and output state.
 */
typedef struct {
    AVFormatContext *fmt_ctx;
    AVCodecContext  *dec_ctx;
    SwrContext      *swr_ctx;
    int              audio_stream_idx;
    int              out_sample_rate;
    int              out_channels;
} DecodeContext;

static void decode_ctx_free(DecodeContext *ctx) {
    if (ctx->swr_ctx)   swr_free(&ctx->swr_ctx);
    if (ctx->dec_ctx)   avcodec_free_context(&ctx->dec_ctx);
    if (ctx->fmt_ctx)   avformat_close_input(&ctx->fmt_ctx);
}

/**
 * Initialize the decode context: open file, find audio stream, open codec, set up resampler.
 * Returns 0 on success.
 */
static int decode_ctx_init(DecodeContext *ctx, const char *file_path) {
    memset(ctx, 0, sizeof(*ctx));
    av_log_set_level(AV_LOG_ERROR);

    int ret = avformat_open_input(&ctx->fmt_ctx, file_path, NULL, NULL);
    if (ret < 0) return FRKB_ERR_OPEN_INPUT;

    ret = avformat_find_stream_info(ctx->fmt_ctx, NULL);
    if (ret < 0) return FRKB_ERR_STREAM_INFO;

    /* Find best audio stream */
    ret = av_find_best_stream(ctx->fmt_ctx, AVMEDIA_TYPE_AUDIO, -1, -1, NULL, 0);
    if (ret < 0) return FRKB_ERR_NO_AUDIO;
    ctx->audio_stream_idx = ret;

    AVStream *stream = ctx->fmt_ctx->streams[ctx->audio_stream_idx];
    const AVCodec *codec = avcodec_find_decoder(stream->codecpar->codec_id);
    if (!codec) return FRKB_ERR_NO_AUDIO;

    ctx->dec_ctx = avcodec_alloc_context3(codec);
    if (!ctx->dec_ctx) return FRKB_ERR_ALLOC;

    ret = avcodec_parameters_to_context(ctx->dec_ctx, stream->codecpar);
    if (ret < 0) return FRKB_ERR_OPEN_CODEC;

    ret = avcodec_open2(ctx->dec_ctx, codec, NULL);
    if (ret < 0) return FRKB_ERR_OPEN_CODEC;

    /* Determine output channel count: use source channels if 1 or 2, else downmix to stereo */
    int src_channels = ctx->dec_ctx->ch_layout.nb_channels;
    ctx->out_channels = (src_channels == 1 || src_channels == 2) ? src_channels : TARGET_CHANNELS;
    ctx->out_sample_rate = ctx->dec_ctx->sample_rate;

    /* Set up SwrContext for conversion to interleaved s16 */
    AVChannelLayout out_layout = (ctx->out_channels == 1)
        ? (AVChannelLayout)AV_CHANNEL_LAYOUT_MONO
        : (AVChannelLayout)AV_CHANNEL_LAYOUT_STEREO;

    ret = swr_alloc_set_opts2(&ctx->swr_ctx,
        &out_layout, TARGET_SAMPLE_FMT, ctx->out_sample_rate,
        &ctx->dec_ctx->ch_layout, ctx->dec_ctx->sample_fmt, ctx->dec_ctx->sample_rate,
        0, NULL);
    if (ret < 0 || !ctx->swr_ctx) return FRKB_ERR_SWR_INIT;

    ret = swr_init(ctx->swr_ctx);
    if (ret < 0) return FRKB_ERR_SWR_INIT;

    return 0;
}

/* ===================== Public API ===================== */

int frkb_ffmpeg_chromaprint_generate(
    const char *file_path,
    int max_duration_sec,
    char **fingerprint_out,
    double *duration_out)
{
    if (!file_path || !fingerprint_out || !duration_out) return FRKB_ERR_ALLOC;
    if (max_duration_sec <= 0) max_duration_sec = 120;

    DecodeContext ctx;
    int ret = decode_ctx_init(&ctx, file_path);
    if (ret != 0) return ret;

    /* Create Chromaprint context */
    ChromaprintContext *cp_ctx = chromaprint_new(CHROMAPRINT_ALGORITHM_DEFAULT);
    if (!cp_ctx) { decode_ctx_free(&ctx); return FRKB_ERR_CHROMAPRINT; }

    if (!chromaprint_start(cp_ctx, ctx.out_sample_rate, ctx.out_channels)) {
        chromaprint_free(cp_ctx);
        decode_ctx_free(&ctx);
        return FRKB_ERR_CHROMAPRINT;
    }

    int64_t max_total_samples = (int64_t)ctx.out_sample_rate * ctx.out_channels * max_duration_sec;
    int64_t total_samples_decoded = 0;

    AVPacket *pkt = av_packet_alloc();
    AVFrame  *frame = av_frame_alloc();
    if (!pkt || !frame) {
        chromaprint_free(cp_ctx);
        decode_ctx_free(&ctx);
        return FRKB_ERR_ALLOC;
    }

    /* Temporary buffer for swr_convert output */
    int buf_capacity = 4096 * ctx.out_channels;
    int16_t *buf = (int16_t *)malloc(buf_capacity * sizeof(int16_t));
    if (!buf) {
        av_frame_free(&frame);
        av_packet_free(&pkt);
        chromaprint_free(cp_ctx);
        decode_ctx_free(&ctx);
        return FRKB_ERR_ALLOC;
    }

    while (av_read_frame(ctx.fmt_ctx, pkt) >= 0) {
        if (pkt->stream_index != ctx.audio_stream_idx) {
            av_packet_unref(pkt);
            continue;
        }

        ret = avcodec_send_packet(ctx.dec_ctx, pkt);
        av_packet_unref(pkt);
        if (ret < 0) break;

        while ((ret = avcodec_receive_frame(ctx.dec_ctx, frame)) == 0) {
            int out_count = swr_get_out_samples(ctx.swr_ctx, frame->nb_samples);
            if (out_count < 0) out_count = frame->nb_samples * 2;

            int needed = out_count * ctx.out_channels;
            if (needed > buf_capacity) {
                buf_capacity = needed * 2;
                int16_t *new_buf = (int16_t *)realloc(buf, buf_capacity * sizeof(int16_t));
                if (!new_buf) { ret = FRKB_ERR_ALLOC; goto finish; }
                buf = new_buf;
            }

            uint8_t *cp_out[1] = { (uint8_t *)buf };
            int converted = swr_convert(ctx.swr_ctx,
                cp_out, out_count,
                (const uint8_t **)frame->extended_data, frame->nb_samples);

            if (converted > 0) {
                int samples_to_feed = converted * ctx.out_channels;
                total_samples_decoded += samples_to_feed;

                if (!chromaprint_feed(cp_ctx, buf, samples_to_feed)) {
                    ret = FRKB_ERR_CHROMAPRINT;
                    goto finish;
                }

                if (max_total_samples > 0 && total_samples_decoded >= max_total_samples) {
                    goto finish;
                }
            }
        }

        if (ret != AVERROR(EAGAIN)) break;
    }

    /* Flush decoder */
    avcodec_send_packet(ctx.dec_ctx, NULL);
    while (avcodec_receive_frame(ctx.dec_ctx, frame) == 0) {
        int out_count = frame->nb_samples * 2;
        int needed = out_count * ctx.out_channels;
        if (needed > buf_capacity) {
            buf_capacity = needed * 2;
            int16_t *new_buf = (int16_t *)realloc(buf, buf_capacity * sizeof(int16_t));
            if (!new_buf) { ret = FRKB_ERR_ALLOC; goto finish; }
            buf = new_buf;
        }
        uint8_t *cp_out_flush[1] = { (uint8_t *)buf };
        int converted = swr_convert(ctx.swr_ctx,
            cp_out_flush, out_count,
            (const uint8_t **)frame->extended_data, frame->nb_samples);
        if (converted > 0) {
            int samples_to_feed = converted * ctx.out_channels;
            total_samples_decoded += samples_to_feed;
            if (!chromaprint_feed(cp_ctx, buf, samples_to_feed)) {
                ret = FRKB_ERR_CHROMAPRINT;
                goto finish;
            }
        }
    }
    ret = 0;

finish:
    free(buf);
    av_frame_free(&frame);
    av_packet_free(&pkt);

    if (ret == 0) {
        if (!chromaprint_finish(cp_ctx)) ret = FRKB_ERR_CHROMAPRINT;
    }

    if (ret == 0) {
        char *fp = NULL;
        if (!chromaprint_get_fingerprint(cp_ctx, &fp)) {
            ret = FRKB_ERR_CHROMAPRINT;
        } else {
            *fingerprint_out = fp;
            *duration_out = (double)total_samples_decoded / (ctx.out_sample_rate * ctx.out_channels);
        }
    }

    chromaprint_free(cp_ctx);
    decode_ctx_free(&ctx);
    return ret;
}
