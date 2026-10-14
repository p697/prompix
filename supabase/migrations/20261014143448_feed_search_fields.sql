-- Derived search fields retain native title/creator relevance without changing content revisions.
create function prompix.normalize_search(value text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select lower(pg_catalog.normalize(regexp_replace(pg_catalog.normalize(coalesce(value,''),'NFKD'), U&'[\0300-\036F]', '', 'g'),'NFKC'))
$$;
revoke all on function prompix.normalize_search(text) from public;
grant execute on function prompix.normalize_search(text) to prompix_reader, prompix_writer;

create function prompix.search_fields(item jsonb, translated jsonb)
returns table(search_titles text[],search_creator text,search_metadata text,search_text text)
language sql immutable parallel safe set search_path = '' as $$
  with fields as (
    select array[item->>'title'] || array(select value->>'title' from jsonb_each(coalesce(translated,'{}'))) as titles,
      concat_ws(' ',item->'creator'->>'displayName', item->'creator'->>'username',
        case when item->'creator'->>'username' is not null then '@' || ltrim(item->'creator'->>'username','@') end,
        item->'creator'->>'platform',item->'source'->>'author') as creator,
      concat_ws(' ',item->>'model', array_to_string(array(select jsonb_array_elements_text(item->'tags')),' ')) as metadata,
      concat_ws(' ',item->>'title',item->>'summary',item->>'prompt',item->>'example',item->>'previewLabel',
        item->'source'->>'name',item->'skill'->>'name',item->'skill'->>'description',item->>'kind',
        case item->>'kind' when 'text' then 'text texte texto テキスト 텍스트 文本 文字'
          when 'image' then 'image images imagen imágenes imagem imagens bild bilder 画像 이미지 图片 圖片'
          when 'video' then 'video videos vidéo vídeos ビデオ 동영상 视频 影片'
          when 'web' then 'web website 網頁 网页 ウェブ 웹' end,
        case when item->>'contentType'='skill' then 'skill skills agent-skills' else 'prompt prompts' end,
        (select string_agg(concat_ws(' ',value->>'title',value->>'summary',value->>'prompt',value->>'example',value->>'previewLabel'),' ')
          from jsonb_each(coalesce(translated,'{}')))) as body
  ) select array(select prompix.normalize_search(value) from unnest(titles) value),
    prompix.normalize_search(creator),prompix.normalize_search(metadata),
    prompix.normalize_search(concat_ws(' ',body,creator,metadata)) from fields
$$;
revoke all on function prompix.search_fields(jsonb,jsonb) from public;
grant execute on function prompix.search_fields(jsonb,jsonb) to prompix_writer;

alter table prompix.revisions add column search_titles text[] not null default '{}',
  add column search_creator text not null default '', add column search_metadata text not null default '';
grant update(search_text,search_titles,search_creator,search_metadata) on prompix.revisions to prompix_writer;
with prepared as (
  select v.id, fields.* from prompix.revisions v cross join lateral prompix.search_fields(v.original,
    (select jsonb_object_agg(t.locale,t.content) from prompix.translations t where t.revision_id=v.id)) fields
) update prompix.revisions v set search_titles=p.search_titles,search_creator=p.search_creator,
  search_metadata=p.search_metadata,search_text=p.search_text from prepared p where p.id=v.id;
update prompix.release_creators set search_text=prompix.normalize_search(concat_ws(' ',
  creator->>'displayName', creator->>'username', '@' || ltrim(creator->>'username','@'), creator->>'platform'));
