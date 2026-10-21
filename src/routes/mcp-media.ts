import type { Context } from 'hono';
import type { Env } from '../types';
import { ALLOWED_TYPES, uploadMedia } from './media';

export const UPLOAD_IMAGE_TOOL = {
    name: 'upload_image',
    description: '이미지를 업로드하고 공개 URL·최종 파일명·r2_key·태그를 반환합니다. data는 파일 원본의 Base64 문자열(data: URL 접두사 제외)이며, filename은 확장자 없는 파일명입니다. 기존 웹 업로드와 같은 형식·파일명·크기 제한(기본 10MB)과 SVG 보안 검증을 적용합니다. 중복 파일명은 숫자 접미사로 구분하며 기존 파일을 덮어쓰지 않습니다. 업로드한 이미지는 공개되며 문서에 삽입하려면 반환된 URL을 사용하세요.',
    inputSchema: { type: 'object', properties: {
        filename: { type: 'string', description: '확장자 없는 파일명. 최대 100자, 공백·경로·마크다운 특수문자 금지' },
        mime_type: { type: 'string', enum: [...ALLOWED_TYPES] },
        data: { type: 'string', description: '이미지 파일 원본의 Base64 인코딩 문자열' },
        tags: { type: 'array', items: { type: 'string' }, description: '선택 사항. 이미지 검색용 태그' },
    }, required: ['filename', 'mime_type', 'data'] },
};

export async function dispatchUploadImageTool(c: Context<Env>, args: Record<string, unknown>) {
    const error = (message: string) => ({ content: [{ type: 'text', text: message }], isError: true });
    if (typeof args.filename !== 'string' || typeof args.mime_type !== 'string'
        || !ALLOWED_TYPES.has(args.mime_type) || typeof args.data !== 'string' || !args.data) {
        return error('유효한 filename, mime_type, Base64 data가 필요합니다.');
    }
    const maxSize = parseInt(c.env.MAX_UPLOAD_SIZE || '10485760', 10);
    if (args.data.length > Math.ceil(maxSize / 3) * 4) {
        return error(`파일 크기는 ${maxSize / (1024 * 1024)}MB 이하만 허용됩니다.`);
    }
    let bytes: Uint8Array<ArrayBuffer>;
    try {
        bytes = Uint8Array.from(atob(args.data), char => char.charCodeAt(0));
    } catch {
        return error('유효하지 않은 Base64 data입니다. data: URL 접두사 없이 보내주세요.');
    }
    if (!bytes.length) return error('빈 이미지 파일은 업로드할 수 없습니다.');
    if (args.tags !== undefined && (!Array.isArray(args.tags) || args.tags.some(tag => typeof tag !== 'string'))) {
        return error('tags는 문자열 배열이어야 합니다.');
    }
    const form = new FormData();
    form.set('file', new File([bytes], '', { type: args.mime_type }));
    form.set('filename', args.filename);
    if (args.tags !== undefined) form.set('tags', JSON.stringify(args.tags));
    const response = await uploadMedia(c, form);
    return { content: [{ type: 'text', text: JSON.stringify(await response.json()) }], isError: !response.ok };
}
