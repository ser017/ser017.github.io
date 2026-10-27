module.exports = {
  layout: "post.njk",
  tags: ["posts"],
  permalink: data => `blog/${data.page.fileSlug}/index.html`,
};
