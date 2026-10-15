# Serves the hexaflake portfolio with nginx. Folder listings under /content/ are JSON.
#   docker build -t hexaflake-portfolio .
#   docker run --rm -p 8080:80 hexaflake-portfolio
# then open http://localhost:8080
#
# To edit content without rebuilding, mount the folder over the copy in the image:
#   docker run --rm -p 8080:80 -v "$PWD/content:/usr/share/nginx/html/content:ro" hexaflake-portfolio
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html styles.css source.js main.js atmosphere.js landscape.js wildlife.js favicon.svg /usr/share/nginx/html/
COPY vendor /usr/share/nginx/html/vendor
COPY models /usr/share/nginx/html/models
COPY content /usr/share/nginx/html/content

EXPOSE 80
