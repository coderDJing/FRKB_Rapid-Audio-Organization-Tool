use std::fs::File;
use std::io::{Cursor, Read};
use std::path::Path;

#[derive(Clone, Debug)]
pub struct RawAnlzSection {
  pub kind: [u8; 4],
  pub header_data: Vec<u8>,
  pub content: Vec<u8>,
}

fn read_exact_array<const N: usize, R: Read>(reader: &mut R) -> Result<[u8; N], String> {
  let mut buffer = [0u8; N];
  reader
    .read_exact(&mut buffer)
    .map_err(|error| format!("read exact failed: {error}"))?;
  Ok(buffer)
}

fn read_u32_be<R: Read>(reader: &mut R) -> Result<u32, String> {
  Ok(u32::from_be_bytes(read_exact_array::<4, _>(reader)?))
}

fn read_section_header<R: Read>(reader: &mut R) -> Result<([u8; 4], u32, u32), String> {
  let kind = read_exact_array::<4, _>(reader)?;
  let size = read_u32_be(reader)?;
  let total_size = read_u32_be(reader)?;
  if size < 12 {
    return Err(format!("invalid section size: {size}"));
  }
  if total_size < size {
    return Err(format!("invalid section total size: {total_size} < {size}"));
  }
  Ok((kind, size, total_size))
}

fn read_sections_from_reader<R: Read>(
  reader: &mut R,
  total_len: usize,
) -> Result<Vec<RawAnlzSection>, String> {
  let mut sections = Vec::new();
  let mut consumed = 0usize;
  while consumed < total_len {
    if total_len - consumed < 12 {
      return Err(format!(
        "remaining bytes too small for section header: {}",
        total_len - consumed
      ));
    }
    let (kind, size, total_size) = read_section_header(reader)?;
    let header_data_len =
      usize::try_from(size - 12).map_err(|_| "header_data_len overflow".to_string())?;
    let content_len =
      usize::try_from(total_size - size).map_err(|_| "content_len overflow".to_string())?;
    let section_len =
      usize::try_from(total_size).map_err(|_| "section_len overflow".to_string())?;
    if consumed + section_len > total_len {
      return Err(format!("section exceeds parent boundary: consumed={consumed}, section={section_len}, total={total_len}"));
    }
    let mut header_data = vec![0u8; header_data_len];
    if header_data_len > 0 {
      reader
        .read_exact(&mut header_data)
        .map_err(|error| format!("read section header data failed: {error}"))?;
    }
    let mut content = vec![0u8; content_len];
    if content_len > 0 {
      reader
        .read_exact(&mut content)
        .map_err(|error| format!("read section content failed: {error}"))?;
    }
    sections.push(RawAnlzSection {
      kind,
      header_data,
      content,
    });
    consumed += section_len;
  }
  Ok(sections)
}

pub fn read_pioneer_anlz_sections(path: &Path) -> Result<Vec<RawAnlzSection>, String> {
  let mut reader = File::open(path).map_err(|error| format!("open anlz failed: {error}"))?;
  let (kind, size, total_size) = read_section_header(&mut reader)?;
  if &kind != b"PMAI" {
    return Err(format!(
      "invalid anlz file header: {}{}{}{}",
      kind[0] as char, kind[1] as char, kind[2] as char, kind[3] as char
    ));
  }
  let header_data_len =
    usize::try_from(size - 12).map_err(|_| "file header_data_len overflow".to_string())?;
  if header_data_len > 0 {
    let mut skip = vec![0u8; header_data_len];
    reader
      .read_exact(&mut skip)
      .map_err(|error| format!("read file header data failed: {error}"))?;
  }
  let content_len =
    usize::try_from(total_size - size).map_err(|_| "file content_len overflow".to_string())?;
  read_sections_from_reader(&mut reader, content_len)
}

pub fn parse_nested_anlz_sections(bytes: &[u8]) -> Result<Vec<RawAnlzSection>, String> {
  let mut cursor = Cursor::new(bytes);
  read_sections_from_reader(&mut cursor, bytes.len())
}

pub fn read_be_u32(bytes: &[u8]) -> Result<u32, String> {
  if bytes.len() < 4 {
    return Err("read_be_u32 requires at least 4 bytes".to_string());
  }
  Ok(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

pub fn section_kind_eq(section: &RawAnlzSection, kind: &[u8; 4]) -> bool {
  &section.kind == kind
}
