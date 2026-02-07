
-- Elementary Map
copy (
    select 
        map.* exclude (fill, INTPTLAT20, INTPTLON20, geom),
        CASE
            WHEN count(*) OVER (PARTITION BY map.GEOID20) > 1
                THEN map.GEOID20 || '-' || row_number() OVER (PARTITION BY map.GEOID20 ORDER BY map.GEOID20, ST_Extent_Approx(map.geom))
            ELSE map.GEOID20
        END as block_of_residence,
        coalesce((select count(id) from student where ST_Contains(map.geom, student.student_location) and student.gr between -2 and 6 and student.sc not between 20 and 23), 0)::int as students,
        coalesce((select count(id) from student where ST_Contains(map.geom, student.resident_location) and student.gr between -2 and 6 and student.sc not between 20 and 23), 0)::int as residents,
        st_y(st_centroid(map.geom)) as INTPTLAT20,
        st_x(st_centroid(map.geom)) as INTPTLON20,
        geom 
    from st_read('../maps/SRCS_Census_Blocks_Fixed.geojson') as map
    where District = 'Elementary'
    order by block_of_residence
) to '../apps/boundary-explorer/maps/elementary_blocks.geojson' with (format gdal, driver 'geojson');

copy (from st_read('../apps/boundary-explorer/maps/elementary_blocks.geojson')) to '../final_maps/Elementary-Blocks.geojson' with (format gdal, driver 'geojson');

-- Secondary Map
copy (
    select 
        map.* exclude (fill, INTPTLAT20, INTPTLON20, geom),
        CASE
            WHEN count(*) OVER (PARTITION BY map.GEOID20) > 1
                THEN map.GEOID20 || '-' || row_number() OVER (PARTITION BY map.GEOID20 ORDER BY map.GEOID20, ST_Extent_Approx(map.geom))
            ELSE map.GEOID20
        END as block_of_residence,
        coalesce((select count(id) from student where ST_Contains(map.geom, student.student_location) and student.gr between 7 and 12 and student.sc not between 20 and 23), 0)::int as students,
        coalesce((select count(id) from student where ST_Contains(map.geom, student.resident_location) and student.gr between 7 and 12 and student.sc not between 20 and 23), 0)::int as residents,
        st_y(st_centroid(map.geom)) as INTPTLAT20,
        st_x(st_centroid(map.geom)) as INTPTLON20,
        geom 
    from st_read('../maps/SRCS_Census_Blocks_Fixed.geojson') as map
    order by block_of_residence
) to '../apps/boundary-explorer/maps/secondary_blocks.geojson' with (format gdal, driver 'geojson');

copy (from st_read('../apps/boundary-explorer/maps/secondary_blocks.geojson')) to '../final_maps/Secondary-Blocks.geojson' with (format gdal, driver 'geojson');