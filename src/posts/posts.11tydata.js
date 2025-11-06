module.exports = {
  layout: "post.njk",
  tags: ["posts"],
  permalink: data => `${data.page.fileSlug}/index.html`,
};
