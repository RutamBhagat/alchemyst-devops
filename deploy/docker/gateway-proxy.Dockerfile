FROM nginx:alpine

COPY deploy/gateway/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
